'use strict'
// DeepSeek Harness 桌面壳。
//
// 拓扑：渲染进程 (dsh://127.0.0.1) ←IPC→ 主进程 ←命名管道→ Node 子进程(harness)。
// 全程没有 TCP 端口。三处关键决定的来由记在 docs/architecture-findings.md：
//
//  · 为什么 harness 跑在单独的 Node 进程而不是主进程 —— Electron 的 V8 嵌入不
//    暴露 Cordis loader 需要的 Node 内部符号（第 1、2 条）。
//  · 为什么载体是命名管道而不是伪造的 node 对象 —— 伪造补不完，真实 socket
//    一次就通，而管道没有端口号（第 10 条）。
//  · 为什么渲染侧靠垫片而不是改上游 —— 载体在客户端插件里写死，但它脚下只有
//    fetch 与 WebSocket 两个全局（renderer/dsh-ipc-shim.js）。

const { app, BrowserWindow, ipcMain, protocol, shell, dialog } = require('electron')
const { fork } = require('node:child_process')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const { proxy, unary, openStream } = require('./host/pipe-bridge.js')
const { installMenu, currentLocale, petEnabled, readPrefs, writePrefs } = require('./host/menu.js')
const { createNotifier } = require('./host/notifications.js')
const { createTray } = require('./host/tray.js')
const { createPet } = require('./host/pet.js')
const { localDay, shouldRoll, strayPetSessions } = require('./host/pet-memory.js')
const { createWallpaperStore, createWallpaperRoutes, ROUTE: WALLPAPER_ROUTE }
  = require('./host/wallpapers.js')
const { fetchSpeech } = require('./host/tts-http.js')
// 文本清理规则只有一份：宠物窗当脚本加载同一个文件，主进程在这里 require 它。
const { speakable: speakableOf } = require('./renderer/pet-voice.js')
// 角色表两边共用：页面拿它挑素材，主进程拿它挑人设预设。写两份迟早对不上，而对
// 不上的表现是"看着是庄方宜，说话是 MIKU"。
const { character: petCharacter, DEFAULT_ID: DEFAULT_CHARACTER } = require('./renderer/pet-characters.js')
const { createPetObserver, textOf } = require('./host/pet-observer.js')
const { createAnnouncer, composeAnnouncement } = require('./host/pet-announce.js')

const DESKTOP = __dirname

/**
 * harness 运行时闭包的位置。
 *
 * 闭包由 `npm run build:runtime` 从本仓库的 harness/ 源码产出：一棵扁平、无符号
 * 链接的 node_modules，加上 CLI 包自身的 lib/ 与 package.json。前端与后端都在
 * 里面，因此界面上跑的就是本仓库的源码，不存在与 npm 上某个版本错位的可能。
 *
 * DSH_DESKTOP_REPO 仍然优先，指向别处的闭包或源码树时用得上。
 */
function resolveRuntimeRoot() {
  if (process.env.DSH_DESKTOP_REPO !== undefined) return process.env.DSH_DESKTOP_REPO

  const candidates = [
    // 打包后：闭包走 extraResources，整个躺在 asar 之外。这一点是硬要求而非
    // 偏好 —— Cordis 的 loader 按真实文件路径解析插件，app-boot 还会据此建一棵
    // 符号链接树，而链接由操作系统解析，穿不过 asar 归档。
    process.resourcesPath === undefined ? undefined : path.join(process.resourcesPath, 'runtime'),
    // 开发期：仓库根的 runtime/，由 `npm run build:runtime` 产出。
    path.join(DESKTOP, '..', 'runtime'),
  ]
  for (const candidate of candidates) {
    if (candidate !== undefined && fs.existsSync(path.join(candidate, 'package.json'))) return candidate
  }
  throw new Error('找不到 harness 运行时闭包。请在仓库根运行 `npm run build:runtime` 先把它构建出来。')
}

const REPO = resolveRuntimeRoot()

/** harness 引导到报告管道地址的容忍时间。首次加载插件树较慢，给足。 */
const BOOT_TIMEOUT_MS = 120_000

/**
 * 宠物聊天的专属目录。
 *
 * 从悬浮窗随口问的东西，和你在主界面里认真推进的项目不该混在一个会话流里 ——
 * 前者是随手记，后者有上下文。给它一个独立目录，harness 会把它登记成独立工作区，
 * 于是两边的历史、工作目录、以及 agent 能碰到的文件都天然分开。
 */
/** 桌面陪伴助手的工作目录根。每个角色在下面各占一间。 */
const PET_ROOT = path.join(app.getPath('home'), '.dsh', 'pet')

/**
 * 某个角色的工作目录。
 *
 * 一人一间而不是共用一间：会话是按 cwd 归属的，同一间屋子里两位的对话会互相看得
 * 见，问 MIKU 的事在庄方宜那边也算数——那正是"串味"。
 *
 * @param {string} who 角色 id
 * @returns {string} 绝对路径
 */
const petWorkspace = (who) => path.join(PET_ROOT, who)

/** 聊天背景壁纸库。放 ~/.dsh 下和其余用户数据作伴，卸载时一并带走。 */
const wallpapers = createWallpaperStore({ dir: path.join(app.getPath('home'), '.dsh', 'wallpapers') })

/**
 * 壁纸的请求处理器。
 *
 * 挂在协议处理器上而不是另开端口，也不另开 IPC：设置面板跑在页面里，页面对这个源
 * 发的 fetch 本来就落到这儿。同源，不需要任何新的桥。
 */
const serveWallpaper = createWallpaperRoutes(wallpapers)

/** @type {import('node:child_process').ChildProcess | null} */
let harness = null
/** @type {BrowserWindow | null} */
let win = null
let pipe = null
let quitting = false

/** 每条下行流的关闭句柄，按渲染侧生成的 id 索引。 */
const streams = new Map()

/** @type {ReturnType<typeof createNotifier> | undefined} */
let notifier
/** @type {ReturnType<typeof createTray> | undefined} */
let tray
/** @type {ReturnType<typeof createPet> | undefined} */
let pet
/** 最近一次状态。宠物是后开的，开的时候要能立刻显示当前状态而不是从空闲开始。 */
let agentState = 'idle'

/**
 * 每一帧也交给宠物一份。
 *
 * 帧处理器注册在更外层，拿不到宠物那一块里的闭包，所以留一个模块级钩子由那边填。
 * 默认是空函数：宠物没开时这条路径什么也不做，调用点不必判空。
 */
let onPetFrame = () => {}

/**
 * 设置面板改完宠物设置后 ping 这里。启动完成后被换成真正的实现。
 *
 * 需要这个钩子是因为协议处理器在引导早期就装好了，而读设置要等管道就绪。
 */
let refreshPetPrefs = () => {}

/** 已经喊过的错误。每帧一行会把日志淹掉，而第一行就够定位了。 */
const warned = new Set()

/**
 * 报告一个不该发生但不致命的错误，同一处只报一次。
 * @param {string} where 出错的位置标签
 * @param {unknown} err 错误对象
 */
function warnOnce(where, err) {
  if (warned.has(where)) return
  warned.add(where)
  console.error(`[${where}]`, err)
}

// ---------------------------------------------------------------- harness

/**
 * 在一个真正的 Node 进程里引导 harness。
 *
 * `--expose-internals` 不是调试开关而是硬需求：Cordis 的 loader 要相对 baseUrl
 * 解析插件，为此需要 Node 内部的 ESM 加载器。少了它，每个插件包都会解析失败。
 *
 * 为什么不是 utilityProcess：开发期它接受 execArgv，但**打包之后这个标志会静默
 * 失效** —— 子进程里 `process.execArgv` 照样能读到 `--expose-internals`，
 * `require('internal/modules/esm/loader')` 却报 Cannot find module。也就是说标志
 * 被原样转达却没有真正生效，症状是打包版从第一个插件起就解析失败，而开发期一切
 * 正常，两边差异毫无提示。
 *
 * 改用 `ELECTRON_RUN_AS_NODE` 派生自身：这个模式下 Electron 就是普通 Node，
 * 命令行标志按 Node 的规则生效。（NODE_OPTIONS 这条路走不通 —— Node 明确拒绝
 * 在其中出现 `--expose-internals`。）
 */
function startHarness() {
  const entry = path.join(DESKTOP, 'host', 'harness-host.js')
  return new Promise((resolve, reject) => {
    harness = fork(entry, [REPO, DESKTOP], {
      execPath: process.execPath,
      execArgv: ['--expose-internals'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      // harness 的日志走 stdio；不接管的话打包版里这些输出会彻底消失。
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })

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

/**
 * 页面的来源。用自有 scheme 而不是 file://，理由见 serveFromPipe。
 *
 * 主机名必须是 127.0.0.1，不能是随手起的名字（比如 `app`）。上游按
 * `location.hostname` 判定"是不是本机"，判成否之后**设置会退化成内存模式并
 * 静默丢弃所有写入** —— 主题、语言、外观全都存不住，而且一声不吭。自有
 * scheme 的主机名本来就是我们自己定的，写成回环地址即可，无需改动上游那道
 * 安全围栏。
 */
const APP_ORIGIN = 'dsh://127.0.0.1'

/**
 * 自绘标题栏的高度。壳与页面必须用同一个值 —— 页面要按它把内容往下让，
 * Windows 的系统按钮覆盖层也按它定高，两边对不齐就会出现一条错位的缝。
 */
const TITLEBAR_HEIGHT = 36

/**
 * 注入页面的脚本。两份分工不同：载体垫片必须最先跑（它换掉 WebApiClient 脚下的
 * WebSocket），设置区注入则只需在页面存在之后跑。
 */
const INJECTED = {
  '/dsh-ipc-shim.js': 'dsh-ipc-shim.js',
}

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
    const url = new URL(request.url)

    // 壁纸归壳自己管，不经管道 —— 也因此不依赖 harness 是否就绪。这条路由排在转发
    // 之前，所以它吃掉的任何路径，harness 都永远看不到。
    if (url.pathname === WALLPAPER_ROUTE || url.pathname.startsWith(WALLPAPER_ROUTE + '/')) {
      try { return await serveWallpaper(request, url) } catch (err) {
        warnOnce('wallpaper', err)
        return new Response('壁纸读写失败', { status: 500 })
      }
    }

    // 设置面板改完宠物设置后 ping 一句"该去看了"。不带数据 —— 权威在设置文档里，
    // 信 ping 带来的值等于给页面开了一条绕过设置的旁路。
    if (url.pathname === '/__pet/refresh') {
      if (request.method !== 'POST') return new Response('只接受 POST', { status: 405 })
      refreshPetPrefs()
      return new Response('{"ok":true}', {
        status: 200, headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }

    if (pipe === null) return new Response('harness 尚未就绪', { status: 503 })

    // 注入脚本来自本地文件，不经管道。
    const injected = INJECTED[url.pathname]
    if (injected !== undefined) {
      return new Response(fs.readFileSync(path.join(DESKTOP, 'renderer', injected)), {
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
      const tag = `<script>window.__dshTitlebarHeight=${TITLEBAR_HEIGHT}</script>`
        + Object.keys(INJECTED).map((p) => `<script src="${p}"></script>`).join('')
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
    /**
     * 这个页面还收得到消息吗。
     *
     * `isDestroyed()` 不够：webContents 还活着，它的渲染帧却可能已经被释放（刷新、
     * 导航、关窗的那一小段）。此时 `send` 不会抛给我们 —— Electron 在内部就把
     * "Render frame was disposed" 打到控制台了，所以外面包 try/catch 拦不住，只能
     * 在调用之前就问清楚。
     *
     * 探针就是去碰一下 `mainFrame`：那正是 `send` 要投递的目标，帧没了访问它会抛，
     * 于是"能不能碰"和"能不能发"是同一件事。
     */
    const reachable = () => {
      if (event.sender.isDestroyed()) return false
      try { return event.sender.mainFrame !== null } catch { return false }
    }

    /**
     * 把一帧转给发起这条流的页面。
     *
     * 页面拆到一半就悄悄丢掉 —— 那是关窗时的正常竞态，不是错误。
     */
    const send = (channel, ...args) => {
      if (!reachable()) return
      try { event.sender.send(channel, id, ...args) } catch { /* 刚好卡在拆的那一下 */ }
    }
    const close = openStream(pipe, req.path, {
      onOpen: () => send('dsh:stream-open'),
      onFrame: (text) => {
        send('dsh:stream-frame', text)
        // 顺带旁听：通知与托盘状态都来自同一批帧，不必再开一条流。
        // 放在转发之后 —— 界面拿到数据的时机不该被通知逻辑拖慢。
        //
        // 只解析一次。旁听方有三个（通知器、旁观器、宠物自己说话），各自解析就是
        // 每帧三遍 JSON.parse；而流式回答一轮能有几百帧 assistant/chunk，这笔开销
        // 全花在把同一段文本重复解析上。
        let payload
        try { payload = JSON.parse(text)?.payload } catch { return }
        if (payload === null || typeof payload !== 'object') return
        try { notifier?.observe(payload) } catch { /* 通知是附加价值，不能影响载体 */ }
        // 坏一帧不能影响载体，但也不能连编程错误一起咽掉 —— 这里曾经吞掉一个
        // 每帧都抛的 ReferenceError，症状是"宠物再也不说话了"，而日志干干净净。
        try { onPetFrame(payload) } catch (err) { warnOnce('pet-frame', err) }
      },
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
    title: 'DeepSeek Client',
    icon: path.join(DESKTOP, 'build', 'icon.png'),
    // 去掉系统标题栏，换成应用自己的那条。两个平台的做法不同，而且都不是
    // "无边框"那么简单：
    //  · macOS 用 hiddenInset —— 红绿灯按钮保留并内缩，这是原生应用的样子；
    //    真做成 frameless 会连红绿灯一起没掉，那不是现代，是坏掉。
    //  · Windows 用 hidden + titleBarOverlay —— 最小化/最大化/关闭仍由系统绘制
    //    在右上角，颜色交给我们。自绘那三个按钮永远差一口气（贴边、高对比模式、
    //    触摸目标尺寸都要自己伺候），没必要。
    ...process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 12 } }
      : {
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#00000000', symbolColor: '#6b7280', height: TITLEBAR_HEIGHT },
      },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(DESKTOP, 'preload.js'),
    },
  })

  // 页面会把 document.title 写成自己的构建名（"DSH Local Build"）。那是上游
  // 前端的品牌，不是这个产品的名字 —— 拦下它，标题栏由壳决定。
  win.on('page-title-updated', (event) => { event.preventDefault() })
  // 回到窗口就说明你已经看见了，托盘上的"等待处理"该消掉。
  win.on('focus', () => { notifier?.clearAttention() })
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

  // 开发者工具走快捷键，不进工具栏：排查界面问题时它是必需的，但对着它做日常
  // 使用的人不该看见入口。F12 与 Ctrl/Cmd+Shift+I 都收，两种习惯都照顾到。
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const toggle = input.key === 'F12'
      || ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i')
    if (!toggle) return
    event.preventDefault()
    win?.webContents.toggleDevTools()
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
      // 语言写进 harness 自己的 locale 设置（namespace 'locale'，字段
      // 'preference'）—— 上游前端订阅它，界面立刻跟着变，不需要重启。
      const applyLocale = async (locale) => {
        if (pipe === null) throw new Error('后台服务尚未就绪')
        const r = await unary(pipe, {
          path: '/api/settings.update',
          body: JSON.stringify({
            type: 'client-request',
            rpcId: randomUUID(),
            method: 'settings.update',
            payload: { ns: 'locale', patch: { preference: locale } },
          }),
        })
        if (r.status !== 200) throw new Error(`settings.update 返回 HTTP ${r.status}`)
        tray?.refresh()
      }
      notifier = createNotifier({
        getWindow: () => win,
        getLocale: currentLocale,
        // 陪伴助手不是"你的智能体"：她的会话不该影响托盘状态，也不该弹完成通知。
        // 认全部角色的，不只当前这位：换过角色之后另一位那条仍在会话表里。
        isPetSession: (id) => isOwnSession(id),
        onState: (state) => { agentState = state; tray?.setState(state); pet?.setState(state) },
        onSay: (kind, detail) => {
          // 'done' 刻意不在这里说话：干完一轮之后宠物要说的是**总结**，那由旁观器
          // 触发（见 petObserver）。这里再喊一句"忙完啦"，只会抢在总结前面把气泡
          // 占掉，然后被总结顶掉 —— 两句话打架，哪句都没看清。
          if (kind === 'done') return
          const zh = currentLocale() === 'zh'
          const text = {
            approval: zh ? `它想用 ${detail}，批一下嘛？` : `It wants to use ${detail} — okay?`,
            question: zh ? '有个问题在等你回答哦' : 'A question is waiting for you',
            error: zh ? '出错啦，去看看？' : 'Something went wrong',
          }[kind]
          // 审批、提问、出错都是"在叫你"，语音提醒的主要用武之地正是这几条：
          // 它们**卡着进度**，没人应答就一直停在那里。
          if (text !== undefined) {
            void readPetPrefs()
              .then((prefs) => speechFor(prefs, true, text))
              .then((speech) => { pet?.say(text, 6000, speech) })
          }
        },
      })
      // DSH_NO_TRAY=1 关掉托盘，用于把它从故障范围里排除。
      if (process.env.DSH_NO_TRAY !== '1') tray = createTray({
        iconDir: path.join(DESKTOP, 'build'),
        getWindow: () => win,
        getLocale: currentLocale,
        onQuit: () => { app.quit() },
      })

      /**
       * 会话：**每个角色各一条，而且只有一条。**
       *
       * 各一条是因为人设和上下文都不该串：跟 MIKU 说过的话不能出现在庄方宜的上下文
       * 里，否则会得到一个自称庄方宜、却记得你跟 MIKU 聊过什么的东西。换回来的时候
       * 也该接上原来那条，而不是从头开始。
       *
       * 只有一条是因为她是桌面上的一个摆件，不是一个项目 —— 跟她说的话不该在侧边栏
       * 里堆成一列会话，更不该每次开应用就多出一条。
       *
       * 记在偏好里而不是只放内存：只放内存的话，每次启动都会另起一条，而旧的那些全
       * 留在会话列表里。会话 id 由我们预先指定，`session.create` 对同一个 id + cwd
       * 是幂等的，于是重启之后接着用的还是同一条。
       *
       * 记忆仍是**暂时的**：随口问的东西不该在几天后还压在上下文里影响回答。跨过
       * 本地日历日就换一条，昨天的事就此翻篇；"新话题"手动换也走同一条路。过期规则
       * 本身在 host/pet-memory.js —— 跨天这条分支等一天才触发一次，留在这里就只能
       * 靠读代码相信它。
       *
       * @type {Map<string, {id: string, day: string, greetedAs: string}>}
       */
      const petSessions = new Map(Object.entries(readPrefs().petSessions ?? {}).flatMap(
        ([who, v]) => (v !== null && typeof v === 'object' && typeof v.id === 'string'
          ? [[who, { id: v.id, day: String(v.day ?? ''), greetedAs: String(v.greetedAs ?? '') }]]
          : []),
      ))

      // 一次性清掉上一版那几个扁平键。它们指向的会话开在旧的扁平工作目录里，换到
      // 一人一间之后 cwd 对不上，接着用是错的 —— 那条会话由启动时的清扫收进归档。
      // 不清的话，写偏好时的 spread 会把它们永远带下去。
      {
        const stale = readPrefs()
        if (stale.petSessionId !== undefined) {
          const { petSessionId, petSessionDay, petGreetedAs, petSessionWho, ...rest } = stale
          writePrefs(rest)
        }
      }

      /** 当前角色那条会话；还没读出角色、或这位还没开过口时为 null。 */
      const petSessionOf = () => (petWho === null ? null : petSessions.get(petWho) ?? null)

      /**
       * 这条会话是不是陪伴助手自己的。
       *
       * 认**全部**角色的，不只当前显示的那位：换过角色之后另一位那条仍然在会话表
       * 里，它说的话同样是"结果"，再喂回旁观器就成了自己总结自己。
       *
       * @param {string} id 会话 id
       * @returns {boolean}
       */
      const isOwnSession = (id) => {
        for (const session of petSessions.values()) if (session.id === id) return true
        return false
      }

      /** 把全部会话记下来，好让下次启动接着用。 */
      const rememberPetSessions = () => {
        writePrefs({ ...readPrefs(), petSessions: Object.fromEntries(petSessions) })
      }

      /**
       * 主窗口是不是正被你看着。
       *
       * 通知器里也有同一条判断（"窗口有焦点就不打扰"）。这里独立写一份而不是从
       * 通知器借：那边判断的是要不要发系统通知，这边判断的是要不要弹气泡，两者
       * 将来完全可能分开演化。
       */
      const mainWindowFocused = () => win !== null && !win.isDestroyed() && win.isFocused()

      const showMainWindow = () => {
        if (win === null || win.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
      /**
       * 宠物窗当前显示的角色。null 表示还没读过设置。
       *
       * 用 null 而不是直接填默认值，是为了把"第一次读出来是庄方宜"和"用户中途换成
       * 庄方宜"分开：后者要作废会话（人设变了），前者不该 —— 那会让每次启动都丢掉
       * 存下来的那条会话。
       */
      let petWho = null

      const setPet = (on) => {
        // 关掉时把攒着的报喜一并丢掉：等它们到点时宠物已经没了，而下次开宠物
        // 又冒出几条几分钟前的旧消息，比不报更让人摸不着头脑。
        if (!on) { announcer.cancel(); pet?.destroy(); pet = undefined; return }
        if (pet !== undefined) return
        pet = createPet({
          characterId: petWho ?? DEFAULT_CHARACTER,
          desktopDir: DESKTOP,
          getLocale: currentLocale,
          onActivate: showMainWindow,
          onFreshTopic: () => {
            // 只丢掉当前这位的那条：下一句话会照常开一条新的并藏起来。偏好里的旧 id
            // 一并清掉，否则重启后又会接回刚被丢掉的那条。另一位的不受影响。
            if (petWho !== null) petSessions.delete(petWho)
            rememberPetSessions()
            pet?.say(currentLocale() === 'zh' ? '好，换个话题' : 'Fresh topic', 2600)
          },
          position: readPrefs().petPosition,
          onMoved: (pos) => { writePrefs({ ...readPrefs(), petPosition: pos }) },
        })
      }
      /**
       * 把一段话交给宠物的会话。
       *
       * 用户直接问、以及旁观到一轮结束后请它总结，走的是**同一条会话** —— 这样
       * "第二点展开说说"这种追问才接得上，不必在两个面上来回切。
       *
       * 会话用 `pet` 预设：那份人设定义了它是谁、怎么说话、以及它没有任何工具。
       * 工作目录仍指向 ~/.dsh/pet，与主界面的项目隔开。
       *
       * 不登记可见工作区：宠物是旁观者而不是一个项目，在侧边栏占一栏只是噪音。
       *
       * 失败原因原样回给调用方 —— 悄悄吞掉的话，用户只会觉得"我发了但什么都没
       * 发生"，那比报错更糟。
       */
      const call = async (method, payload) => {
        const r = await unary(pipe, {
          path: `/api/${method}`,
          body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
        })
        if (r.status !== 200) throw new Error(`${method} HTTP ${r.status}`)
        const parsed = JSON.parse(r.body)
        if (parsed?.result?.ok !== true) {
          throw new Error(parsed?.result?.error?.message ?? `${method} 被拒绝`)
        }
        return parsed.result.value
      }

      /**
       * 读宠物那一节设置（设置 → 通用设置 → 桌面宠物）。
       *
       * 每次要用的时候现读，不做缓存：上游没有"设置变了"的下行帧，缓存就只能靠猜
       * 什么时候过期，而猜错的表现是你在设置里改完、宠物却还按旧的来。这是一条本地
       * 管道调用，一次报喜读一次，代价可以忽略。
       *
       * 读不到就用默认值：编一个占位称呼（"用户""你好"）比不称呼更糟，而语音默认
       * 关着 —— 会出声的东西必须是被要求的，不能靠一次更新自己冒出来。
       *
       * @returns {Promise<{nickname: string, voice: boolean, voiceName: string,
       *   voiceRate: number, voiceVolume: number, voiceScope: string}>}
       */
      const readPetPrefs = async () => {
        const fallback = {
          character: DEFAULT_CHARACTER,
          nickname: '', voice: false, voiceName: '',
          voiceRate: 1.1, voiceVolume: 0.85, voiceScope: 'alerts',
        }
        if (pipe === null) return fallback
        try {
          const described = await call('settings.describe', {})
          const section = described?.namespaces?.find((n) => n.ns === 'pet')?.value
          if (section === null || typeof section !== 'object') return fallback
          return {
            // 认不得的 id 由 petCharacter 回落到默认角色，所以这里不必自己判断
            character: petCharacter(String(section.character ?? '')).id,
            nickname: String(section.nickname ?? '').trim().slice(0, 16),
            voice: section.voice === true,
            voiceName: String(section.voiceName ?? ''),
            voiceRate: Number(section.voiceRate) || fallback.voiceRate,
            voiceVolume: Number.isFinite(Number(section.voiceVolume))
              ? Number(section.voiceVolume) : fallback.voiceVolume,
            voiceScope: section.voiceScope === 'all' ? 'all' : 'alerts',
          }
        } catch { return fallback }
      }

      /**
       * 把设置翻成 `pet.say` 要的朗读参数。
       *
       * 外接服务在这里就把音频合成好，随消息一起送过去。合成放在主进程而不是宠物
       * 窗里：那个窗口是 file:// 源，够不着外部地址，而且密钥不该出现在页面里。
       *
       * 外接失败就退回系统音色，并把原因记一次日志 —— 静音是最糟的失败方式，用户
       * 只会觉得"这功能坏了"，而不知道是密钥过期还是地址填错。
       *
       * @param {object} prefs readPetPrefs 的结果
       * @param {boolean} isAlert 这一条是不是"在叫你"（报喜、审批、提问、出错）
       * @param {string} text 要念的原文
       * @returns {Promise<object | null>} null 表示这一条不念
       */
      const speechFor = async (prefs, isAlert, text) => {
        if (!prefs.voice) return null
        // 闲聊的回答默认不念：那是你主动问出来的，正看着它。
        if (!isAlert && prefs.voiceScope !== 'all') return null
        const base = {
          enabled: true,
          name: prefs.voiceName,
          rate: prefs.voiceRate,
          volume: prefs.voiceVolume,
        }
        if (prefs.voiceProvider !== 'http') return base
        const made = await fetchSpeech(prefs, speakableOf(text))
        if (made.ok) return { ...base, audio: made.dataUri }
        warnOnce('tts-http', new Error(made.error))
        return base
      }

      /**
       * 把一条会话从所有分组界面里摘掉。
       *
       * 跟摆件说的话不该在侧边栏里占位置。宠物会话没有登记工作区，于是落进"未分组"
       * 那一栏 —— 那正是用户看到的"分组"。归档是上游给的唯一隐藏手段：会话本身照常
       * 活着、照常收发，只是不在任何分组界面出现（见 workspace.archiveSession）。
       *
       * 失败不上抛：藏不住只是难看，不该因此连话都发不出去。
       */
      const hideSession = async (sessionId) => {
        try { await call('workspace.archiveSession', { sessionId }) }
        catch (err) { warnOnce('pet-archive', err) }
      }

      /**
       * 开一条新的宠物会话（并藏起来）。
       *
       * id 由我们指定：`session.create` 对同一个 id + cwd 是幂等的，所以重启之后拿
       * 着存下来的 id 再调一次，接上的还是原来那条，而不是又多一条。
       */
      const openPetSession = async (day, who) => {
        // 目录得是真的：session.create 拿 cwd 去登记，路径不存在会被拒。
        const cwd = petWorkspace(who)
        fs.mkdirSync(cwd, { recursive: true })
        const id = `session-${randomUUID()}`
        const created = (await call('session.create', {
          sessionId: id,
          cwd,
          // 人设跟着角色走。庄方宜不该用 MIKU 那份人设说话。
          agentPreset: petCharacter(who).preset,
        }))?.sessionId ?? null
        if (created === null) return null
        await hideSession(created)
        const session = { id: created, day, greetedAs: '' }
        petSessions.set(who, session)
        rememberPetSessions()
        return session
      }

      /**
       * 启动时把所有宠物会话扫一遍藏起来。
       *
       * 只在新建时藏是不够的：这个目录下可能已经堆了一批（早先的版本每次启动都另起
       * 一条），而且归档集是全局持久的，重复归档是幂等的。按 cwd 认而不是按记下来的
       * id 认 —— 记下来的只有最新那条，早先那些正是要清掉的。
       */
      const sweepPetSessions = async () => {
        try {
          const [listed, spaces] = await Promise.all([
            call('session.list', {}),
            call('workspace.list', {}),
          ])
          const stray = strayPetSessions(
            listed?.items,
            spaces?.archivedSessionIds ?? [],
            PET_ROOT,
            // Windows 上大小写不敏感；分隔符也要统一成 /，否则上面那个前缀判断
            // 在混着反斜杠的路径上比不上。
            (p) => path.resolve(p).split(path.sep).join('/').toLowerCase(),
          )
          for (const sessionId of stray) await hideSession(sessionId)
          if (stray.length > 0) console.log(`[pet] 已从会话列表里收起 ${stray.length} 条宠物会话`)
        } catch (err) { warnOnce('pet-sweep', err) }
      }

      const petPrompt = async (text) => {
        if (pipe === null) return { ok: false, error: '后台服务尚未就绪' }
        try {
          // 跨天就翻篇。判断放在发送前而不是定时器里：宠物大多数时候没人理，定时器
          // 只会在无人使用时空转，而真正要紧的是"今天第一次说话"这一刻。
          // 先确认这句话是说给谁的。角色各有各的会话，认错人就串味了。
          const prefsNow = await readPetPrefs()
          const who = prefsNow.character
          const today = localDay()
          // 跨天就翻篇。判断放在发送前而不是定时器里：她大多数时候没人理，定时器只
          // 会在无人使用时空转，而真正要紧的是"今天第一次说话"这一刻。
          const rolled = shouldRoll(petSessions.get(who) ?? null, today)
          if (rolled) petSessions.delete(who)

          let session = petSessions.get(who) ?? null
          if (session === null) session = await openPetSession(today, who)
          const sessionId = session?.id ?? null
          if (sessionId === null) return { ok: false, error: '没能建立 MIKU 的会话' }

          // 昵称只在**改过之后的第一句**里交代一次。人设是静态的，读不到设置；每条
          // 都带上则是把同一句话反复塞进上下文，既费 token 又显得啰嗦。记下交代过的
          // 那个名字，改了名才重说一次 —— 否则你在设置里改完，她还会一直叫旧的。
          let outgoing = text
          const { nickname } = prefsNow
          if (nickname !== session.greetedAs) {
            session.greetedAs = nickname
            rememberPetSessions()
            if (nickname !== '') {
              const zh = currentLocale() === 'zh'
              const note = zh ? `（称呼我为「${nickname}」）` : `(Call me “${nickname}”.)`
              outgoing = `${note}${String.fromCharCode(10)}${String.fromCharCode(10)}${text}`
            }
          }

          await call('session.prompt', {
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: outgoing }],
          })
          // 她自己在想 —— 这一下由我们直接驱动，不再走通知器：托盘现在（正确地）
          // 不把宠物算作"你的智能体"，于是她自己的回合不会再产生状态推送。
          pet?.setState('running')
          if (rolled) {
            // 忘掉这件事必须让人知道：否则宠物会显得莫名其妙地不记得昨天说过的话。
            pet?.say(currentLocale() === 'zh' ? '新的一天啦，昨天的事 MIKU 忘光光咯' : 'New day~ yesterday is all gone', 3600)
          }
          return { ok: true }
        } catch (err) {
          return { ok: false, error: String(err && err.message ? err.message : err).slice(0, 120) }
        }
      }

      /** 悬浮窗里直接问的那条路。 */
      const petAsk = (text) => petPrompt(text)

      /**
       * 别的智能体干完一轮，宠物过来报一声。
       *
       * 值不值得报、几件事该不该并成一句，都由 pet-announce 定 —— 那两条规则各自
       * 要等几十秒才能在真机上复现一次，放在能直接测的模块里。这里只负责说出来。
       *
       * 停留时长按行数给：一件事一句话，四秒够看；并了五件事的那句有六行，四秒
       * 只够读个开头。
       */
      const announceBatch = async (digests) => {
        if (pet === undefined) return
        // 你正看着主窗口，就不用她来转述了 —— 那一轮的输出就在你眼前，气泡只是
        // 挡住它。仍然鼓个掌：有反馈、不抢注意力，比彻底没反应容易理解。
        //
        // 判断放在这里而不是收素材的时候：中间隔着最多十几秒的攒批，那会儿你在
        // 看哪扇窗口和现在没关系。
        if (mainWindowFocused()) { pet.play('done'); return }
        const prefs = await readPetPrefs()
        const text = composeAnnouncement(digests, prefs.nickname, currentLocale() === 'zh')
        if (text === '') return
        pet.play('done')
        pet.say(text, Math.min(20000, 6000 + digests.length * 2000), await speechFor(prefs, true, text))
      }

      const announcer = createAnnouncer({ emit: (batch) => { void announceBatch(batch) } })

      /**
       * 宠物自己说的话进气泡。
       *
       * 停留时长按字数给：一句"好"挂十几秒是碍事，三行总结给四秒又读不完。
       */
      const routePetSpeech = (frame) => {
        const mine = petSessionOf()
        if (pet === undefined || mine === null) return
        // 只认**当前这位**的：另一位的会话可能还在跑（比如刚换过角色），她的话不该
        // 从现在这位嘴里冒出来。
        if (frame?.type !== 'session/event' || frame.sessionId !== mine.id) return
        if (frame.event?.type !== 'assistant/message') return
        const said = textOf(frame.event.data?.message?.content)
        if (said === '') return
        pet.play('reply')
        // 想完了，回到真实的智能体状态 —— 不是一律回待机：你问她的时候主界面那位
        // 可能正忙着，那才是她该显示的。
        pet.setState(agentState)
        // 先读设置再弹，而不是弹完再补一次朗读：say 一次就是一个气泡，补第二次会
        // 把刚弹出来的那个顶掉重来。读设置走本地管道，这点延迟看不出来。
        // 这条不是"在叫你"，是你主动问出来的 —— 只有把朗读范围调成"也念聊天回答"
        // 才会念。
        void readPetPrefs()
          .then((prefs) => speechFor(prefs, false, said))
          .then((speech) => { pet?.say(said, Math.min(24000, Math.max(6000, said.length * 220)), speech) })
      }

      const petObserver = createPetObserver({
        isPetSession: (id) => isOwnSession(id),
        onDigest: (digest) => {
          // 宠物没开就没人看，不必攒。
          if (pet === undefined) return
          announcer.offer(digest)
        },
      })

      onPetFrame = (frame) => {
        petObserver.observe(frame)
        routePetSpeech(frame)
      }

      // 三档模式（idle/bubble/open）原样透传。这里曾经写成 expanded === true 的
      // 布尔判断，于是 'open' 被折成 false，点开之后窗口纹丝不动 —— 而页面那边
      // class 已经加上了，看起来像动画失效，实则是尺寸没跟上。
      ipcMain.handle('dsh:pet-resize', (_e, mode, height) => { pet?.resize(String(mode), Number(height)) })
      ipcMain.handle('dsh:pet-ask', (_e, text) => petAsk(String(text ?? '')))
      ipcMain.on('dsh:pet-move', (_e, dx, dy) => { pet?.moveBy(Number(dx) || 0, Number(dy) || 0) })
      ipcMain.on('dsh:pet-menu', () => { pet?.handleMenu() })
      /**
       * 设置里可能改了角色，去看一眼。
       *
       * 上游没有"设置变了"的下行帧，所以由设置面板那边改完主动 ping 一下（见
       * /__pet/refresh）。这里不信 ping 带来的值，自己重新读一遍设置 —— 权威在
       * 设置文档里，ping 只是"该去看了"这个信号。
       */
      const applyPetPrefs = async () => {
        const prefs = await readPetPrefs()
        if (prefs.character === petWho) return
        const first = petWho === null
        petWho = prefs.character
        if (first) return
        // 会话不用动：每位各有各的一条，换回来时接着说，换过去时用她自己的那条。
        pet?.setCharacter(petWho)
      }

      /**
       * 页面画得出来了，这才把状态推过去。
       *
       * 以前是建完窗口立刻推，而那时页面还没加载完，消息没有接收方 —— 失败被
       * executeJavaScript 的 catch 悄悄吞掉，于是开宠物时哪怕智能体正在跑，她也
       * 一律是待机的。改由页面报到之后再推，"什么时候能收"由能收的那一方说了算。
       */
      // 设置面板改完之后会 ping /__pet/refresh，落到这里。
      refreshPetPrefs = () => { void applyPetPrefs() }

      ipcMain.on('dsh:pet-ready', () => {
        pet?.setState(agentState)
        pet?.play('greet')   // 出场打个招呼
      })
      // 开宠物挪到引导之后（见 showApp 那一段）：这里还读不到设置，先开出来会先
      // 显示默认角色再跳到真正的那个，闪一下。
      // 菜单要等 setPet 定义之后再装：它把 setPet 作为回调交出去，早一步调用
      // 会撞上 const 的暂时性死区，整个启动直接抛错。
      installMenu(applyLocale, setPet)

      // 先把窗口开出来（启动画面），再去引导 —— 引导要几秒，那几秒不该是空白。
      createWindow()
      splashStatus('正在启动后台服务…')
      pipe = await startHarness()
      splashStatus('正在载入界面…')
      serveFromPipe()
      registerBridge()
      showApp()

      // 先读出是谁，再把宠物开出来 —— 顺序反过来会先画默认角色再换，闪一下。
      await applyPetPrefs()
      if (petEnabled()) setPet(true)

      // 扫一遍历史遗留的宠物会话，把它们从"未分组"里收起来。
      //
      // 必须排在 startHarness 之后 —— 它要发 RPC，而在那之前 pipe 还是 null，
      // 调用会以 HTTP 0 失败。不 await：只关系到列表好不好看，不该让界面等它。
      void sweepPetSessions()
    } catch (err) {
      // 先打日志再弹框：对话框在某些启动情形下根本显示不出来（无窗口、
      // 被其他模态挡住、CI 环境），那时控制台是唯一的线索。只有对话框的话，
      // 失败就变成了'点了图标什么都没发生'。
      console.error('[启动失败]', err && err.stack ? err.stack : err)
      dialog.showErrorBox('DeepSeek Client 启动失败', String(err instanceof Error ? err.message : err))
      app.quit()
    }
  })

  // 开了宠物模式就不随主窗口退出 —— 宠物本身就是这个应用在桌面上的存在，
  // 关个窗口把它一起收走，等于让"后台陪着"这件事无从谈起。没开宠物时维持
  // 最不意外的行为：关掉即退出。
  app.on('window-all-closed', () => { if (!petEnabled()) app.quit() })
  app.on('before-quit', () => {
    quitting = true
    for (const close of streams.values()) close()
    streams.clear()
    pet?.destroy()
    tray?.destroy()
    harness?.postMessage('shutdown')
    harness?.kill()
  })
}
