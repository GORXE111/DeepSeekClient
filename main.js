'use strict'

// DeepSeek Harness 桌面壳。
//
// 拓扑：渲染进程 (file://) ←IPC→ 主进程 ←命名管道→ utilityProcess(harness)。
// 全程没有 TCP 端口。三处关键决定的来由记在 docs/architecture-findings.md：
//
//  · 为什么 harness 跑在 utilityProcess 而不是主进程 —— Electron 的 V8 嵌入不
//    暴露 Cordis loader 需要的 Node 内部符号（第 1、2 条）。
//  · 为什么载体是命名管道而不是伪造的 node 对象 —— 伪造补不完，真实 socket
//    一次就通，而管道没有端口号（第 10 条）。
//  · 为什么渲染侧靠垫片而不是改上游 —— 载体在客户端插件里写死，但它脚下只有
//    fetch 与 WebSocket 两个全局（renderer/dsh-ipc-shim.js）。

const { app, BrowserWindow, ipcMain, protocol, shell, dialog, utilityProcess } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { proxy, unary, openStream } = require('./host/pipe-bridge.js')
const { installMenu } = require('./host/menu.js')

/** harness 仓库根目录；DSH_DESKTOP_REPO 覆盖。 */
const REPO = process.env.DSH_DESKTOP_REPO ?? 'E:\\DEEPSEEK\\deepseek-harness'
const DESKTOP = __dirname

/** harness 引导到报告管道地址的容忍时间。首次加载插件树较慢，给足。 */
const BOOT_TIMEOUT_MS = 120_000

/** @type {import('electron').UtilityProcess | null} */
let harness = null
/** @type {BrowserWindow | null} */
let win = null
let pipe = null
let quitting = false

/** 每条下行流的关闭句柄，按渲染侧生成的 id 索引。 */
const streams = new Map()

// ---------------------------------------------------------------- harness

/**
 * 在 utilityProcess 里引导 harness。
 *
 * `--expose-internals` 不是调试开关而是硬需求：Cordis 的 loader 要相对 baseUrl
 * 解析插件，为此需要 Node 内部的 ESM 加载器。少了它，每个插件包都会解析失败。
 */
function startHarness() {
  const entry = path.join(DESKTOP, 'host', 'harness-host.js')
  return new Promise((resolve, reject) => {
    harness = utilityProcess.fork(entry, [REPO, DESKTOP], { execArgv: ['--expose-internals'] })

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`harness 在 ${BOOT_TIMEOUT_MS / 1000}s 内没有报告管道地址。`))
    }, BOOT_TIMEOUT_MS)

    harness.on('message', (msg) => {
      if (msg?.type === 'error') { console.error('[harness]', msg.payload); return }
      if (msg?.type === 'fatal') {
        if (settled) { reportHarnessDeath(msg.payload); return }
        settled = true
        clearTimeout(timer)
        reject(new Error(msg.payload))
        return
      }
      if (msg?.type !== 'ready' || settled) return
      settled = true
      clearTimeout(timer)
      console.log(`[harness] 就绪 · 管道 ${msg.payload.pipe}`)
      console.log(`[harness] 路由 ${msg.payload.routes.join(' | ')}`)
      console.log(`[harness] 下行 ${msg.payload.upgrades.join(' | ')}`)
      resolve(msg.payload.pipe)
    })

    harness.on('exit', (code) => {
      harness = null
      if (settled) { if (!quitting) reportHarnessDeath(`后台服务退出，code ${code}`) ; return }
      settled = true
      clearTimeout(timer)
      reject(new Error(`harness 未能启动就退出了（code ${code}）`))
    })
  })
}

function reportHarnessDeath(detail) {
  if (win !== null && !win.isDestroyed()) win.destroy()
  dialog.showErrorBox('DeepSeek Harness 已停止', String(detail))
  app.quit()
}

// ---------------------------------------------------------------- 页面来源

/** 页面的来源。用自有 scheme 而不是 file://，理由见 serveFromPipe。 */
const APP_ORIGIN = 'dsh://app'

/** 垫片的对外路径。放在自有 scheme 下，与页面同源。 */
const SHIM_PATH = '/dsh-ipc-shim.js'

/**
 * 把渲染进程的每一个请求转到管道上。
 *
 * 一开始走的是 file:// —— 上游 resolveBase() 显式处理了 origin 为 null 的情形，
 * 看起来正是为此准备的。但前端还要从 /plugins/ 动态加载插件 bundle，那些不是
 * dist 里的文件而是服务器生成的，且由 <script> 标签加载 —— 垫片只能拦 fetch，
 * 拦不到标签。file:// 这条路因此走不通。
 *
 * 自定义协议则覆盖渲染进程发出的全部请求：入口页、assets、/plugins bundle 与
 * /api 调用都从同一个地方转发，页面也因此有了正常的同源关系。unary 的 fetch
 * 垫片随之不再需要 —— 同源 fetch 自然落进这里。
 */
function serveFromPipe() {
  protocol.handle('dsh', async (request) => {
    if (pipe === null) return new Response('harness 尚未就绪', { status: 503 })
    const url = new URL(request.url)

    // 垫片本身来自本地文件，不经管道。
    if (url.pathname === SHIM_PATH) {
      return new Response(fs.readFileSync(path.join(DESKTOP, 'renderer', 'dsh-ipc-shim.js')), {
        status: 200,
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
      })
    }
    const body = request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : Buffer.from(await request.arrayBuffer())
    const result = await proxy(pipe, {
      // 空路径要补成 '/'：上游的 fallback 认这个路径去发入口页。
      path: (url.pathname === '' ? '/' : url.pathname) + url.search,
      method: request.method,
      headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
      body,
    })
    if (result.error !== undefined) return new Response(result.error, { status: 502 })

    // 入口页要带上垫片，而且必须排在页面任何脚本之前 —— 它换掉的是
    // WebApiClient 脚下的 WebSocket，晚一步就有连接已经走了原生路径。
    if ((result.headers['content-type'] ?? '').includes('text/html')) {
      const html = result.body.toString('utf8')
      const tag = `<script src="${SHIM_PATH}"></script>`
      const injected = html.includes('<head>') ? html.replace('<head>', `<head>
${tag}`) : `${tag}
${html}`
      const headers = { ...result.headers }
      // 长度变了：留着旧的 content-length 会让响应被截断。
      delete headers['content-length']
      return new Response(injected, { status: result.status, headers })
    }

    // 其余逐字透传：content-type 决定浏览器怎么解析这份 bundle，
    // 猜错会让一个本来正确的响应以脚本语法错误的形式失败。
    return new Response(result.body, { status: result.status, headers: result.headers })
  })
}

// ---------------------------------------------------------------- IPC 载体

function registerBridge() {
  ipcMain.handle('dsh:unary', async (_event, req) => {
    if (pipe === null) return { status: 0, body: '', error: 'harness 尚未就绪' }
    // 路径由渲染进程给出，必须约束形状：它直接进管道请求的 path。
    if (typeof req?.path !== 'string' || !req.path.startsWith('/api/') || req.path.includes('..')) {
      return { status: 0, body: '', error: `非法路径 ${String(req?.path)}` }
    }
    return unary(pipe, req)
  })

  ipcMain.handle('dsh:stream-open', (event, req) => {
    if (pipe === null) throw new Error('harness 尚未就绪')
    if (typeof req?.path !== 'string' || !req.path.startsWith('/api/') || req.path.includes('..')) {
      throw new Error(`非法路径 ${String(req?.path)}`)
    }
    const id = req.id
    const send = (channel, ...args) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, id, ...args)
    }
    const close = openStream(pipe, req.path, {
      onOpen: () => send('dsh:stream-open'),
      onFrame: (text) => send('dsh:stream-frame', text),
      onClose: () => { streams.delete(id); send('dsh:stream-close') },
    })
    streams.set(id, close)
    return id
  })

  ipcMain.on('dsh:stream-close-request', (_event, id) => {
    const close = streams.get(id)
    streams.delete(id)
    close?.()
  })
}

// ---------------------------------------------------------------- 窗口

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    // 立刻显示。等 ready-to-show 会让"点了图标什么都没有"持续到 harness 引导
    // 完成 —— 那正是要消灭的那段空白。先出启动画面，内容就绪后再换。
    show: true,
    backgroundColor: '#fbfbfc',
    title: 'DeepSeek Harness',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(DESKTOP, 'preload.js'),
    },
  })

  win.on('closed', () => { win = null })

  // 这个窗口是应用，不是通用浏览器：外链交给系统浏览器，站内导航不得离开 dist。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      event.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  })

  // 先上启动画面；harness 就绪后由 showApp() 换成真正的界面。
  void win.loadFile(path.join(DESKTOP, 'renderer', 'splash.html'))
}

/** 把一行状态推给启动画面。窗口已经换成应用界面之后调用是无害的空操作。 */
function splashStatus(text) {
  if (win === null || win.isDestroyed()) return
  void win.webContents.executeJavaScript(
    `window.__dshSplash?.(${JSON.stringify(text)})`,
  ).catch(() => { /* 已经不是启动画面了 */ })
}

/** 换到真正的界面。 */
function showApp() {
  if (win === null || win.isDestroyed()) return
  void win.loadURL(`${APP_ORIGIN}/`)
}

// ---------------------------------------------------------------- 生命周期

// 必须在 app ready 之前声明：standard 让它有正常的同源语义，secure 让页面被
// 当作安全上下文（crypto.randomUUID 等要用），supportFetchAPI 让页面的 fetch
// 也走 protocol.handle。
protocol.registerSchemesAsPrivileged([{
  scheme: 'dsh',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}])

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win === null) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.whenReady().then(async () => {
    try {
      installMenu(() => { app.relaunch(); app.exit(0) })
      // 先把窗口开出来（启动画面），再去引导 —— 引导要几秒，那几秒不该是空白。
      createWindow()
      splashStatus('正在启动后台服务…')
      pipe = await startHarness()
      splashStatus('正在载入界面…')
      serveFromPipe()
      registerBridge()
      showApp()
    } catch (err) {
      dialog.showErrorBox('DeepSeek Harness 启动失败', String(err instanceof Error ? err.message : err))
      app.quit()
    }
  })

  app.on('window-all-closed', () => { app.quit() })
  app.on('before-quit', () => {
    quitting = true
    for (const close of streams.values()) close()
    streams.clear()
    harness?.postMessage('shutdown')
    harness?.kill()
  })
}
