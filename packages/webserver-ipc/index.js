/**
 * 不监听任何端口的 `webServer` 替身。
 *
 * 上游 `@deepseek-ai/dsh-client-connection` 声明了 `inject = ['webServer']`，
 * 没有这个服务它根本不会激活 —— 而它身上长着 /api 路由、WebSocket upgrade、
 * 以及那张 PRIVILEGED_METHODS 表。桌面端不想要 HTTP 服务器，却想要它全部的策略。
 *
 * 所以这里不 fork 它，而是把它依赖的服务换掉：接口一致、没有 socket。它照常
 * 把路由注册进来，我们从 IPC 收到请求后合成 node 的 req/res 喂给同一个处理器。
 * 上游此后新增或收紧任何策略，桌面端自动继承 —— 没有任何一行安全逻辑被复制。
 *
 * 这个替身刻意保持"哑"：只做登记与分发，不判断谁能调什么。那是上游路由处理器
 * 的职责，把它留在那里正是本设计的全部意义。
 *
 * @module @dsh-desktop/webserver-ipc
 */

import { Service } from '@deepseek-ai/cordis'

/**
 * 已挂载替身的进程级句柄，挂在 globalThis 的全局符号注册表上。
 *
 * Cordis 的服务只对同一棵插件树可见，而真正要用这些路由的是引导它的宿主代码
 * （utilityProcess 的入口），它在树外。模块级变量在这里不够用：loader 从
 * profile 目录加载本模块，宿主若按自己的路径 import，两条 URL 会得到两个互不
 * 相干的实例 —— 宿主那份的 `current` 永远是空的，而且这种失败是静默的。
 *
 * Symbol.for 的注册表按进程而非按模块实例，正是为这种跨实例握手而设的。
 */
const HANDLE = Symbol.for('dsh-desktop.webserver-ipc.handle')

/**
 * 开发期信标。utilityProcess 的 stdio 不转发，console 在这里等于哑掉；
 * parentPort 是同一进程里唯一能传出去的通道。宿主不在 utilityProcess 里时静默。
 */
function beacon(what) {
  try { process.parentPort?.postMessage(`__BEACON__ [stub] ${what}`) } catch { /* 非 utility 进程 */ }
}
beacon('模块已求值')

/** @returns 当前已挂载的替身；未挂载时抛错而不是返回空，避免调用方拿着 undefined 走很远。 */
export function webServerIpc() {
  const handle = globalThis[HANDLE]
  if (handle === undefined) throw new Error('webserver-ipc: 替身尚未挂载')
  return handle
}

/** node:http 的路径匹配顺序：先全表精确匹配，再最长前缀，最后 fallback。 */
function matchRoute(routes, pathname) {
  let best
  for (const route of routes) {
    if (route.kind === 'exact') {
      if (route.path === pathname) return route
      continue
    }
    if (pathname === route.path || pathname.startsWith(`${route.path}/`)) {
      if (best === undefined || route.path.length > best.path.length) best = route
    }
  }
  return best
}

export class WebServerIpc extends Service {
  /** @type {import('./types').Route[]} */
  routes = []
  /** @type {Map<string, unknown>} */
  upgrades = new Map()
  /** @type {((req: unknown, res: unknown) => unknown) | undefined} */
  fallback
  /** @type {((html: string) => string)[]} */
  indexTaps = []

  constructor(ctx) {
    super(ctx, 'webServer')
    beacon('构造函数已执行')
    if (globalThis[HANDLE] !== undefined) {
      // 第二次挂载会让宿主握到一个不再被写入的路由表，而且这种错只在请求发不出去
      // 时才浮现。宁可在挂载处炸掉。
      throw new Error('webserver-ipc: 同一进程内重复挂载替身')
    }
    globalThis[HANDLE] = this
  }

  /**
   * 端口与绑定宿主是组合期事实，别的插件会读它们做自适应（例如 directory-picker
   * 判断自己该用原生还是浏览器选择器）。桌面端没有监听 socket，但这两个值必须
   * 是"看起来像回环"的答案：报一个非回环地址会让上游按远程部署的姿态收窄能力。
   */
  get port() { return 0 }
  get host() { return '127.0.0.1' }

  register(route) {
    if (this.routes.some(r => r.kind === route.kind && r.path === route.path)) {
      // 与上游同样的姿态：同表内路径冲突是配置错误，不是可以后来居上的事。
      throw new Error(`webserver-ipc: 路由路径重复 ${route.path}`)
    }
    this.routes.push(route)
    return () => { this.routes = this.routes.filter(r => r !== route) }
  }

  registerUpgrade(route) {
    if (this.upgrades.has(route.path)) {
      throw new Error(`webserver-ipc: upgrade 路径重复 ${route.path}`)
    }
    this.upgrades.set(route.path, route)
    return () => { this.upgrades.delete(route.path) }
  }

  registerFallback(handler) {
    if (this.fallback !== undefined) {
      throw new Error('webserver-ipc: fallback 已被占用')
    }
    this.fallback = handler
    return () => { this.fallback = undefined }
  }

  tapIndex(transform) {
    this.indexTaps.push(transform)
    return () => { this.indexTaps = this.indexTaps.filter(t => t !== transform) }
  }

  applyIndexTaps(html) {
    return this.indexTaps.reduce((acc, transform) => transform(acc), html)
  }

  /**
   * 按 pathname 取出该走的处理器，交给宿主去喂合成的 req/res。
   * 找不到具名路由时返回 fallback；两者都没有则返回 undefined，由调用方答 404。
   */
  routeFor(pathname) {
    return matchRoute(this.routes, pathname) ?? (this.fallback === undefined ? undefined : { handler: this.fallback })
  }

  /** 取 upgrade 路由（精确匹配，与上游一致）。 */
  upgradeFor(pathname) {
    return this.upgrades.get(pathname)
  }

  /**
   * 上游在这里 createServer 并 listen，并且 init 是 async —— Cordis 会 await 它，
   * 用它标记'这个服务已经可用'。替身没有 socket 可等，但契约要一致：返回一个
   * 已 resolve 的 promise，而不是同步 undefined。
   */
  async [Service.init]() {
    beacon('init 已执行（无 socket）')
  }
}

export default WebServerIpc
