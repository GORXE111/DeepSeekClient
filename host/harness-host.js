'use strict'

/**
 * utilityProcess 入口：在真实 Node 里引导 harness，并把它的 /api 表面
 * 挂到一条命名管道上。
 *
 * 为什么是 utilityProcess 而不是 Electron 主进程：Cordis 的 loader 需要 Node
 * 内部的 ESM 加载器才能相对 baseUrl 解析插件，而 Electron 的 V8 嵌入不暴露它
 * 所需的符号（Unsupported/no-realm），退回裸 import 后每个插件包都找不到。
 * utilityProcess 跑的是真实 Node 且接受 execArgv，带 --expose-internals 即可。
 *
 * 为什么是命名管道而不是 TCP 端口：目标是"没有网络端口"，不是"不用 http"。
 * 管道让 req/res 保持为货真价实的 IncomingMessage/ServerResponse —— 上游的
 * bridge 因此拿到它期待的一切，我们不必伪造 node 对象、也不会随上游演进漂移
 * —— 而管道没有端口号，远程不可达。伪造过一版，卡在请求体读完之后、响应产生
 * 之前，字段补不胜补；真实对象一次就通。
 *
 * 安全姿态与原来持平：管道的默认 ACL 允许本机其他进程连接，正如原来的回环
 * TCP 端口一样，而上游那道信任栅栏两种载体都照常生效。要更严需要每次启动
 * 生成一个共享密钥头，属于后续工作。
 *
 * @module harness-host
 */

const http = require('node:http')
const path = require('node:path')
const { createRequire } = require('node:module')
const { readdirSync, readFileSync } = require('node:fs')
const { randomBytes } = require('node:crypto')
const { pathToFileURL } = require('node:url')

/** 这些路径由父进程在 fork 时通过 argv 传入，避免在两处各写一份默认值。 */
const [, , REPO, DESKTOP] = process.argv

/** utilityProcess 的 stdio 不转发，postMessage 是唯一能传出去的通道。 */
const say = (type, payload) => { process.parentPort.postMessage({ type, payload }) }

/**
 * apps/cli 没有 exports 字段，构建产物又按内容哈希命名，只能按特征认门面块：
 * 它只做一次再导出（`export { runProfile }`），实现块则把 runProfile 混在一长串
 * 重命名导出里。认错会立刻在取具名导出时报错，不会静默走偏。
 *
 * 产品化时这里应改为打包期固化，而不是运行时扫描。
 */
function resolveProfileBootFacade() {
  const dir = path.join(REPO, 'apps/cli/lib')
  const hits = readdirSync(dir)
    .filter((f) => f.startsWith('profile-boot-') && f.endsWith('.js'))
    .filter((f) => /export\s*\{\s*runProfile\s*\}/.test(readFileSync(path.join(dir, f), 'utf8')))
  if (hits.length !== 1) {
    throw new Error(`apps/cli/lib 里匹配到 ${hits.length} 个 runProfile 门面块，期望恰好 1 个：${hits.join(', ')}`)
  }
  return pathToFileURL(path.join(dir, hits[0])).href
}

/** 替身把自己挂在全局符号注册表上：它由 loader 从 profile 目录加载，与这里不是同一个模块实例。 */
const STUB_HANDLE = Symbol.for('dsh-desktop.webserver-ipc.handle')

/** 等一个值出现；超时抛错而不是无限等待，卡住时要能说清卡在哪一步。 */
async function waitFor(read, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`等待 ${what} 超时（${timeoutMs}ms）`)
}

/** 每次启动一条新管道：残留的旧管道会让新实例绑定失败，而进程 id 会被复用。 */
function pipePath() {
  const id = `${process.pid}-${randomBytes(4).toString('hex')}`
  return process.platform === 'win32' ? `\\\\.\\pipe\\dsh-desktop-${id}` : `/tmp/dsh-desktop-${id}.sock`
}

async function main() {
  const { runProfile } = await import(resolveProfileBootFacade())
  const reqCli = createRequire(path.join(REPO, 'apps/cli/package.json'))
  const { loadLayeredEnv } = await import(pathToFileURL(reqCli.resolve('@deepseek-ai/dsh-app-boot')).href)

  await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'web',
    patchFiles: [path.join(DESKTOP, 'desktop.patch.yml')],
    // --no-open 只是保险：web-runtime 的开浏览器动作在没有真实监听地址时本就不该发生。
    args: ['--no-open'],
  })

  const stub = await waitFor(() => globalThis[STUB_HANDLE], 'webServer 替身挂载')

  const server = http.createServer((req, res) => {
    // 路径匹配交给替身（与上游同序：精确 → 最长前缀 → fallback），
    // 处理器则是上游自己注册的那一个，信任栅栏与特权方法表都长在里面。
    const route = stub.routeFor(new URL(req.url ?? '/', 'http://x').pathname)
    if (route === undefined) { res.writeHead(404); res.end(); return }
    Promise.resolve(route.handler(req, res)).catch((err) => {
      say('error', `路由处理失败: ${String(err && err.message ? err.message : err)}`)
      if (!res.headersSent) { res.writeHead(500); res.end() }
    })
  })

  // 两条下行流（events.mux / events.host）是 WebSocket upgrade，不是普通请求。
  // 上游把它们注册成 upgrade 路由，替身照单收下；这里只负责按 pathname 转交，
  // 协议握手与连接内容仍归上游的 handler 所有 —— 与它在真实 web 服务器上时
  // 拿到的东西逐字节一致，因为管道上的 socket 也是真的。
  server.on('upgrade', (req, socket, head) => {
    let route
    try {
      route = stub.upgradeFor(new URL(req.url ?? '/', 'http://x').pathname)
    } catch {
      socket.destroy()
      return
    }
    if (route === undefined) { socket.destroy(); return }
    // 与上游 webserver 同样的姿态：socket 上的错误只记日志并销毁，绝不让一条
    // 坏连接掀翻整个进程。
    socket.on('error', (err) => { say('error', `upgrade socket: ${String(err.message)}`) })
    Promise.resolve(route.handler(req, socket, head)).catch((err) => {
      say('error', `upgrade 处理失败: ${String(err && err.message ? err.message : err)}`)
      socket.destroy()
    })
  })

  const pipe = pipePath()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(pipe, resolve)
  })

  say('ready', {
    pipe,
    routes: stub.routes.map((r) => `${r.kind}:${r.path}`),
    upgrades: [...stub.upgrades.keys()],
  })

  process.parentPort.on('message', (e) => {
    if (e?.data === 'shutdown') { server.close(); process.exit(0) }
  })
}

main().catch((err) => {
  // AggregateError 把真实原因藏在 .errors 里，摊平才看得见是哪条 entry 挂了。
  const lines = []
  const flatten = (e, depth = 0) => {
    lines.push(`${'  '.repeat(depth)}${String(e && e.message ? e.message : e)}`)
    if (e && Array.isArray(e.errors)) for (const inner of e.errors) flatten(inner, depth + 1)
    else if (e && e.cause) flatten(e.cause, depth + 1)
  }
  flatten(err)
  say('fatal', lines.join('\n'))
  process.exit(1)
})
