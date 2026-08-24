/**
 * 不监听任何端口的 `webServer` 替身。
 *
 * 上游 `@deepseek-ai/dsh-client-connection` 声明了 `inject = ['webServer']`，
 * 没有这个服务它根本不会激活 —— 而它身上长着 /api 路由、WebSocket upgrade、
 * 以及那张 PRIVILEGED_METHODS 表。桌面端不想要 HTTP 服务器，却想要它全部的策略。
 *
 * **继承上游的 WebServer，只覆盖"不监听"这一件事。**
 *
 * 第一版是照着接口自己实现一遍的，结果被上游的演进打脸：0.1.1 给服务加了
 * `renderIndex` 与 `collectIndexInjections`（结构化的 index 注入表），而替身
 * 没有，前端启动直接报 `ctx.webServer.renderIndex is not a function`。照着接口
 * 重写等于签下一份要永远跟着上游走的合同，而且违约时才发现。
 *
 * 继承之后，路由匹配顺序、index taps、注入渲染、错误姿态全部白拿；上游此后
 * 新增方法也自动生效。我们只改一件事：`Service.init` 不去 createServer/listen。
 *
 * 代价是要碰几个 TypeScript 标了 private 的运行时成员（`match`/`fallback`/
 * `upgrades`）。这是有意的取舍：它们在 JS 里就是普通成员，而万一上游改名，
 * 失败会是响亮的 "not a function"，不是悄悄跑偏。比起自己维护一份会静默腐坏
 * 的接口副本，这个更容易发现也更容易修。
 *
 * @module @dsh-desktop/webserver-ipc
 */

import { Service } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'

/**
 * 已挂载替身的进程级句柄，挂在 globalThis 的全局符号注册表上。
 *
 * Cordis 的服务只对同一棵插件树可见，而真正要用这些路由的是引导它的宿主代码
 * （utilityProcess 的入口），它在树外。模块级变量在这里不够用：loader 从
 * profile 目录加载本模块，宿主若按自己的路径 import，两条 URL 会得到两个互不
 * 相干的实例 —— 宿主那份永远是空的，而且这种失败是静默的。
 */
const HANDLE = Symbol.for('dsh-desktop.webserver-ipc.handle')

/** @returns 当前已挂载的替身；未挂载时抛错而不是返回空，避免调用方拿着 undefined 走很远。 */
export function webServerIpc() {
  const handle = globalThis[HANDLE]
  if (handle === undefined) throw new Error('webserver-ipc: 替身尚未挂载')
  return handle
}

export class WebServerIpc extends WebServer {
  /**
   * 去掉继承来的配置 schema。
   *
   * 上游的 WebServer 要求 `{host, port}` 必填 —— 那是给"要监听哪里"用的。替身
   * 不监听，这两个值由它自己决定（回环 + 0），让组合层再写一遍等于把一个无从
   * 选择的东西伪装成可配置项，写错了还会被 schema 挡在门外。
   *
   * 静态成员会被继承，所以必须显式抹掉，而不是不写。
   */
  static Config = undefined

  constructor(ctx) {
    // 上游构造函数要一份 {host, port}。桌面端不监听，但这两个值仍是组合期事实
    // ——别的插件会读它们做自适应（例如 directory-picker 判断该用原生还是浏览器
    // 选择器）。报一个非回环地址会让上游按远程部署的姿态收窄能力，所以给回环。
    super(ctx, { host: '127.0.0.1', port: 0 })
    if (globalThis[HANDLE] !== undefined) {
      // 第二次挂载会让宿主握到一个不再被写入的路由表，而这种错只在请求发不出去
      // 时才浮现。宁可在挂载处炸掉。
      throw new Error('webserver-ipc: 同一进程内重复挂载替身')
    }
    globalThis[HANDLE] = this
  }

  /** 上游从 listen 结果读端口；这里没有 socket，直接给 0（"未监听"）。 */
  get port() { return 0 }

  /**
   * 上游在这里 createServer 并 listen。替身的全部意义就是不做这件事 ——
   * 但契约要一致：init 是 async，Cordis 用它标记服务已可用。
   */
  async [Service.init]() {}

  /**
   * 按 pathname 取出该走的处理器，交给宿主去喂真实的 req/res。
   *
   * 复用上游的 `match`（精确 → 最长前缀），不自己再实现一遍顺序 —— 顺序错了
   * 的症状是"某个请求偶尔走到 fallback"，极难查。
   */
  routeFor(pathname) {
    const route = this.match(pathname)
    if (route !== undefined) return route
    return this.fallback === undefined ? undefined : { handler: this.fallback }
  }

  /** 取 upgrade 路由（精确匹配，与上游一致）。 */
  upgradeFor(pathname) {
    return this.upgrades.get(pathname)
  }

  /** 宿主要报告已捕获的路由，用于启动日志与自检。 */
  get capturedRoutes() {
    return [
      ...[...this.exact.values()].map((r) => `exact:${r.path}`),
      ...[...this.prefixes.values()].map((r) => `prefix:${r.path}`),
    ]
  }

  /** 宿主要报告已捕获的 upgrade 路径。 */
  get capturedUpgrades() {
    return [...this.upgrades.keys()]
  }
}

export default WebServerIpc
