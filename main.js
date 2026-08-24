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
const { pathToFileURL } = require('node:url')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const { proxy, unary, openStream } = require('./host/pipe-bridge.js')
const { installMenu, currentLocale, petEnabled, readPrefs, writePrefs } = require('./host/menu.js')
const { THEMES, resolveAppearance } = require('./host/appearance.js')
const { createNotifier } = require('./host/notifications.js')
const { createTray } = require('./host/tray.js')
const { createPet } = require('./host/pet.js')

const DESKTOP = __dirname

/**
 * harness 运行时的位置。
 *
 * 它是这个包的普通依赖，所以按包名解析就够了 —— npm 装完是一棵扁平可解析的
 * 树，打成安装包时由 asarUnpack 把它留在 asar 之外（Node 要按真实路径解析它）。
 * 两种分发方式因此共用同一条代码路径，不必各写一套。
 *
 * DSH_DESKTOP_REPO 仍然优先，那是对着源码仓库开发时用的。
 */
function resolveRuntimeRoot() {
  if (process.env.DSH_DESKTOP_REPO !== undefined) return process.env.DSH_DESKTOP_REPO
  try {
    return path.dirname(require.resolve('@deepseek-ai/dsh/package.json'))
  } catch (err) {
    throw new Error(`找不到 harness 运行时（@deepseek-ai/dsh）：${String(err && err.message ? err.message : err)}`)
  }
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

/** @type {import('electron').UtilityProcess | null} */
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

/**
 * 自绘标题栏的高度。壳与页面必须用同一个值 —— 页面要按它把内容往下让，
 * Windows 的系统按钮覆盖层也按它定高，两边对不齐就会出现一条错位的缝。
 */
const TITLEBAR_HEIGHT = 36

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
      const tag = `<script>window.__dshTitlebarHeight=${TITLEBAR_HEIGHT};window.__dshAppearance=${JSON.stringify(resolveAppearance(readPrefs()))}</script><script src="${SHIM_PATH}"></script>`
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
          const zh = currentLocale() === 'zh'
          const text = {
            approval: zh ? `要用 ${detail}，批准吗？` : `May I use ${detail}?`,
            question: zh ? '我有个问题想问你' : 'I have a question for you',
            done: zh ? '忙完啦' : 'All done',
            error: zh ? '出错了，去看看？' : 'Something went wrong',
          }[kind]
          if (text !== undefined) pet?.say(text, kind === 'done' ? 3200 : 6000)
        },
      })
      // DSH_NO_TRAY=1 关掉托盘，用于把它从故障范围里排除。
      if (process.env.DSH_NO_TRAY !== '1') tray = createTray({
        iconDir: path.join(DESKTOP, 'build'),
        getWindow: () => win,
        getLocale: currentLocale,
        onQuit: () => { app.quit() },
      })

      /** @type {BrowserWindow | null} */
      let appearanceWin = null
      /** 宠物会话。整个进程期内复用同一个，"新话题"才换。 */
      let petSessionId = null

      /** 把当前外观推给主窗口。改一次推一次 —— 外观是看着调的。 */
      const pushAppearance = () => {
        if (win !== null && !win.isDestroyed()) {
          win.webContents.send('dsh:appearance', resolveAppearance(readPrefs()))
        }
      }

      const openAppearance = () => {
        if (appearanceWin !== null && !appearanceWin.isDestroyed()) { appearanceWin.focus(); return }
        appearanceWin = new BrowserWindow({
          width: 460, height: 620, resizable: false,
          title: currentLocale() === 'zh' ? '外观' : 'Appearance',
          // 面板是主窗口的附属，不该在任务栏里另占一格。
          parent: win ?? undefined, skipTaskbar: true, minimizable: false, maximizable: false,
          webPreferences: {
            nodeIntegration: false, contextIsolation: true, sandbox: true,
            preload: path.join(DESKTOP, 'host', 'appearance-preload.js'),
          },
        })
        appearanceWin.setMenuBarVisibility(false)
        appearanceWin.on('closed', () => { appearanceWin = null })
        void appearanceWin.loadFile(path.join(DESKTOP, 'renderer', 'appearance.html'))
      }

      ipcMain.handle('dsh:appearance-init', () => {
        const prefs = readPrefs()
        return {
          themes: THEMES.map((t) => ({ id: t.id, zh: t.zh, en: t.en, swatch: t.swatch })),
          locale: currentLocale(),
          theme: prefs.theme ?? 'default',
          accentColor: prefs.accentColor ?? null,
          chatBackground: prefs.chatBackground ?? { kind: 'none', opacity: 0.18 },
        }
      })
      ipcMain.on('dsh:appearance-update', (_e, next) => {
        writePrefs({
          ...readPrefs(),
          theme: typeof next?.theme === 'string' ? next.theme : 'default',
          accentColor: typeof next?.accentColor === 'string' ? next.accentColor : null,
          chatBackground: next?.chatBackground ?? { kind: 'none' },
        })
        pushAppearance()
      })
      ipcMain.handle('dsh:appearance-pick-image', async () => {
        const r = await dialog.showOpenDialog({
          properties: ['openFile'],
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] }],
        })
        if (r.canceled || r.filePaths.length === 0) return ''
        // 页面从 dsh:// 加载，拿不到本地文件；转成 file:// 才引用得到。
        return pathToFileURL(r.filePaths[0]).href
      })

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
            petSessionId = null
            pet?.say(currentLocale() === 'zh' ? '好，换个话题' : 'Fresh topic', 2600)
          },
          position: readPrefs().petPosition,
          onMoved: (pos) => { writePrefs({ ...readPrefs(), petPosition: pos }) },
        })
        pet.setState(agentState)
      }
      /**
       * 把一句话发给一个会话。
       *
       * 目标会话取最近一个；一个都没有就在第一个工作区里新建。悬浮窗的价值是
       * "想到就记下"，不该反过来要求用户先去主界面挑一个会话。
       *
       * 失败原因原样回给页面 —— 悄悄吞掉的话，用户只会觉得"我发了但什么都没
       * 发生"，那比报错更糟。
       */
      const petAsk = async (text) => {
        if (pipe === null) return { ok: false, error: '后台服务尚未就绪' }
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
        try {
          // 目录不存在时先建：session.create 拿 cwd 去登记工作区，目录得是真的。
          fs.mkdirSync(PET_WORKSPACE, { recursive: true })
          if (petSessionId === null) {
            petSessionId = (await call('session.create', { cwd: PET_WORKSPACE }))?.sessionId ?? null
          }
          const sessionId = petSessionId
          if (sessionId === null) return { ok: false, error: '没能建立宠物会话' }
          await call('session.prompt', {
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          })
          return { ok: true }
        } catch (err) {
          return { ok: false, error: String(err && err.message ? err.message : err).slice(0, 120) }
        }
      }
      // 三档模式（idle/bubble/open）原样透传。这里曾经写成 expanded === true 的
      // 布尔判断，于是 'open' 被折成 false，点开之后窗口纹丝不动 —— 而页面那边
      // class 已经加上了，看起来像动画失效，实则是尺寸没跟上。
      ipcMain.handle('dsh:pet-resize', (_e, mode) => { pet?.resize(String(mode)) })
      ipcMain.handle('dsh:pet-ask', (_e, text) => petAsk(String(text ?? '')))
      ipcMain.on('dsh:pet-activate', () => { pet?.handleActivate() })
      ipcMain.on('dsh:pet-menu', () => { pet?.handleMenu() })
      if (petEnabled()) setPet(true)

      // 菜单要等 setPet 定义之后再装：它把 setPet 作为回调交出去，早一步调用
      // 会撞上 const 的暂时性死区，整个启动直接抛错。
      installMenu(applyLocale, openAppearance, setPet)

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
