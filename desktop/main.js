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
const { localDay, shouldRoll } = require('./host/pet-memory.js')
const { createPetObserver, textOf } = require('./host/pet-observer.js')

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
const PET_WORKSPACE = path.join(app.getPath('home'), '.dsh', 'pet')

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
    if (pipe === null) return new Response('harness 尚未就绪', { status: 503 })
    const url = new URL(request.url)

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
    const send = (channel, ...args) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, id, ...args)
    }
    const close = openStream(pipe, req.path, {
      onOpen: () => send('dsh:stream-open'),
      onFrame: (text) => {
        send('dsh:stream-frame', text)
        // 顺带旁听：通知与托盘状态都来自同一批帧，不必再开一条流。
        // 放在转发之后 —— 界面拿到数据的时机不该被通知逻辑拖慢。
        try { notifier?.observe(text) } catch { /* 通知是附加价值，不能影响载体 */ }
        // 坏一帧不能影响载体，但也不能连编程错误一起咽掉 —— 这里曾经吞掉一个
        // 每帧都抛的 ReferenceError，症状是"宠物再也不说话了"，而日志干干净净。
        try { onPetFrame(text) } catch (err) { warnOnce('pet-frame', err) }
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
        onState: (state) => { agentState = state; tray?.setState(state); pet?.setState(state) },
        onSay: (kind, detail) => {
          // 'done' 刻意不在这里说话：干完一轮之后宠物要说的是**总结**，那由旁观器
          // 触发（见 petObserver）。这里再喊一句"忙完啦"，只会抢在总结前面把气泡
          // 占掉，然后被总结顶掉 —— 两句话打架，哪句都没看清。
          if (kind === 'done') return
          const zh = currentLocale() === 'zh'
          const text = {
            approval: zh ? `要用 ${detail}，批准吗？` : `May I use ${detail}?`,
            question: zh ? '我有个问题想问你' : 'I have a question for you',
            error: zh ? '出错了，去看看？' : 'Something went wrong',
          }[kind]
          if (text !== undefined) pet?.say(text, 6000)
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
       * 宠物会话，连同它建立的那一天。
       *
       * 宠物的记忆是**暂时的**：随口问的东西不该在几天后还压在上下文里影响回答。
       * 跨过本地日历日就换一个会话，昨天的事就此翻篇；"新话题"手动换也走同一条路。
       *
       * 过期规则本身在 host/pet-memory.js —— 跨天这条分支等一天才触发一次，留在
       * 这里就只能靠读代码相信它。
       */
      let petSession = null

      const showMainWindow = () => {
        if (win === null || win.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
      const setPet = (on) => {
        if (!on) { pet?.destroy(); pet = undefined; return }
        if (pet !== undefined) return
        pet = createPet({
          desktopDir: DESKTOP,
          getLocale: currentLocale,
          onActivate: showMainWindow,
          onFreshTopic: () => {
            petSession = null
            pet?.say(currentLocale() === 'zh' ? '好，换个话题' : 'Fresh topic', 2600)
          },
          position: readPrefs().petPosition,
          onMoved: (pos) => { writePrefs({ ...readPrefs(), petPosition: pos }) },
        })
        pet.setState(agentState)
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
       * 读用户给宠物定的昵称（设置 → 通用设置）。
       *
       * 读不到就返回空串，届时不称呼 —— 编一个占位（"用户""你好"）比不称呼更糟。
       */
      const readNickname = async () => {
        if (pipe === null) return ''
        try {
          const described = await call('settings.describe', {})
          const section = described?.namespaces?.find((n) => n.ns === 'pet')?.value
          return String(section?.nickname ?? '').trim().slice(0, 16)
        } catch { return '' }
      }

      const petPrompt = async (text) => {
        if (pipe === null) return { ok: false, error: '后台服务尚未就绪' }
        try {
          // 目录得是真的：session.create 拿 cwd 去登记，路径不存在会被拒。
          fs.mkdirSync(PET_WORKSPACE, { recursive: true })
          // 跨天就翻篇。判断放在发送前而不是定时器里：宠物大多数时候没人理，定时器
          // 只会在无人使用时空转，而真正要紧的是"今天第一次说话"这一刻。
          const today = localDay()
          const rolled = shouldRoll(petSession, today)
          if (rolled) petSession = null

          if (petSession === null) {
            const created = (await call('session.create', {
              cwd: PET_WORKSPACE,
              agentPreset: 'pet',
            }))?.sessionId ?? null
            petSession = created === null ? null : { id: created, day: today, greeted: false }
          }
          const sessionId = petSession?.id ?? null
          if (sessionId === null) return { ok: false, error: '没能建立宠物的会话' }

          // 昵称只在一条会话的**第一句**里交代一次。人设是静态的，读不到设置；每条
          // 都带上则是把同一句话反复塞进上下文，既费 token 又显得啰嗦。
          let outgoing = text
          if (!petSession.greeted) {
            petSession.greeted = true
            const nickname = await readNickname()
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
          if (rolled) {
            // 忘掉这件事必须让人知道：否则宠物会显得莫名其妙地不记得昨天说过的话。
            pet?.say(currentLocale() === 'zh' ? '新的一天，昨天的事我忘啦' : 'New day — yesterday is gone', 3600)
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
       * 这条**不经过模型**。早先的做法是把那一轮的问答喂给宠物，让它用自己的话总结，
       * 结果是总结与实际不符 —— 一个小模型隔着一份被截断的素材去转述另一个模型的
       * 工作，说错是常态而不是意外，而说错的代价是你以为任务成了。
       *
       * 现在只报事实：任务是什么（你自己提的那句话，不可能错）、它完成了。要看内容
       * 就去主界面，那里有完整的原文。
       */
      const announceDone = async (digest) => {
        const nickname = await readNickname()
        const zh = currentLocale() === 'zh'
        // 折掉换行再截断：气泡是单块文本，原样带换行会把一句话撑成半屏。
        const task = digest.prompt.replace(/\s+/g, ' ').trim()
        const brief = task.length > 24 ? `${task.slice(0, 24)}…` : task
        const address = nickname === '' ? '' : (zh ? `${nickname}，` : `${nickname}, `)
        const body = brief === ''
          ? (zh ? '刚才那轮任务搞定了' : 'that task is done')
          : (zh ? `你的「${brief}」任务搞定了` : `your task “${brief}” is done`)
        pet?.say(address + body, 9000)
      }

      /**
       * 宠物自己说的话进气泡。
       *
       * 停留时长按字数给：一句"好"挂十几秒是碍事，三行总结给四秒又读不完。
       */
      const routePetSpeech = (text) => {
        if (pet === undefined || petSession === null) return
        let frame
        try { frame = JSON.parse(text)?.payload } catch { return }
        if (frame?.type !== 'session/event' || frame.sessionId !== petSession.id) return
        if (frame.event?.type !== 'assistant/message') return
        const said = textOf(frame.event.data?.message?.content)
        if (said === '') return
        pet.say(said, Math.min(24000, Math.max(6000, said.length * 220)))
      }

      const petObserver = createPetObserver({
        isPetSession: (id) => petSession?.id === id,
        onDigest: (digest) => {
          // 宠物没开就没人看，不必费事。
          if (pet === undefined) return
          void announceDone(digest)
        },
      })

      onPetFrame = (text) => {
        petObserver.observe(text)
        routePetSpeech(text)
      }

      // 三档模式（idle/bubble/open）原样透传。这里曾经写成 expanded === true 的
      // 布尔判断，于是 'open' 被折成 false，点开之后窗口纹丝不动 —— 而页面那边
      // class 已经加上了，看起来像动画失效，实则是尺寸没跟上。
      ipcMain.handle('dsh:pet-resize', (_e, mode) => { pet?.resize(String(mode)) })
      ipcMain.handle('dsh:pet-ask', (_e, text) => petAsk(String(text ?? '')))
      ipcMain.on('dsh:pet-activate', () => { pet?.handleActivate() })
      ipcMain.on('dsh:pet-move', (_e, dx, dy) => { pet?.moveBy(Number(dx) || 0, Number(dy) || 0) })
      ipcMain.on('dsh:pet-menu', () => { pet?.handleMenu() })
      if (petEnabled()) setPet(true)

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
