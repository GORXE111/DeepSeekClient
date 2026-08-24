'use strict'

// DeepSeek Harness 桌面壳（方案 A）。
//
// 这一版不改 harness 一行代码：主进程把现成的 web profile 当子进程拉起来，让它
// 绑到一个由系统挑选的端口上，再把窗口指向那个 URL。用户看不到浏览器，也看不到
// 端口号；harness 内部仍然是 HTTP + WebSocket 那套载体。
//
// 端口刻意不写死。写死意味着第二个实例会撞端口，而 --port 0 让内核挑一个空闲的，
// 代价只是要从 stdout 把它读回来 —— 那行 URL 是 shell 自己打印的，属于公开约定。
//
// 真正去掉端口是方案 B 的事：换一个走 IPC 的 AbstractApiClient 子类，dist 由
// file:// 加载，webserver 插件整个摘掉。届时这个文件里 spawn 与 URL 解析的部分
// 会被 host 的进程内引导替换，窗口与生命周期管理这部分可以原样留用。

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs')

// ---------------------------------------------------------------- 配置

/** harness 仓库根目录；DSH_DESKTOP_REPO 覆盖，便于把壳挪到别处。 */
const REPO = process.env.DSH_DESKTOP_REPO ?? 'E:\\DEEPSEEK\\deepseek-harness'

/**
 * 跑 harness 用的 Node。必须是 22.19+：scripts 与 CLI 用到 `import.meta.main`，
 * 在更旧的 Node 上它是 undefined，入口会静默不执行、退出码还是 0。
 * Electron 自带的 Node 不一定够新，所以这里显式指向外部解释器，顺带把 harness
 * 的崩溃与壳隔离开。
 */
const NODE = process.env.DSH_DESKTOP_NODE ?? 'E:\\DEEPSEEK\\node24\\node.exe'

/** harness 启动到打印 URL 的容忍时间。首次 tsx 转译较慢，给足。 */
const BOOT_TIMEOUT_MS = 90_000

// ---------------------------------------------------------------- 状态

/** @type {import('node:child_process').ChildProcess | null} */
let harness = null
/** @type {BrowserWindow | null} */
let win = null
/** 主动退出中：子进程此时的非零退出码是我们自己造成的，不该报错给用户。 */
let quitting = false

// ---------------------------------------------------------------- harness 生命周期

/**
 * 拉起 web profile 并等它打印监听地址。
 * @returns {Promise<string>} 形如 http://127.0.0.1:53124 的 origin
 */
function startHarness() {
  const entry = path.join(REPO, 'apps', 'cli', 'src', 'bin.ts')
  if (!fs.existsSync(entry)) {
    return Promise.reject(new Error(`找不到 harness 入口：${entry}\n设置 DSH_DESKTOP_REPO 指向仓库根目录。`))
  }
  if (!fs.existsSync(NODE)) {
    return Promise.reject(new Error(`找不到 Node 解释器：${NODE}\n设置 DSH_DESKTOP_NODE 指向 22.19+ 的 node。`))
  }

  return new Promise((resolve, reject) => {
    harness = spawn(
      NODE,
      ['--import', 'tsx/esm', entry, 'web', '--no-open', '--port', '0'],
      // cwd 必须是仓库根：tsx 与工作区依赖都从这里解析。
      { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )

    let settled = false
    let log = ''

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`harness 在 ${BOOT_TIMEOUT_MS / 1000}s 内没有报告监听地址。\n\n输出：\n${log.slice(-2000)}`))
    }, BOOT_TIMEOUT_MS)

    // URL 行由 CLI shell 打印（"dsh web: http://127.0.0.1:PORT"）。只认回环地址：
    // 壳绝不该把窗口指到一个非本机的 origin 上去。
    const scan = (chunk) => {
      const text = String(chunk)
      log += text
      process.stdout.write(`[harness] ${text}`)
      if (settled) return
      const hit = /http:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(text)
      if (hit === null) return
      settled = true
      clearTimeout(timer)
      resolve(`http://127.0.0.1:${hit[1]}`)
    }

    harness.stdout.on('data', scan)
    harness.stderr.on('data', scan)

    harness.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })

    harness.on('exit', (code, signal) => {
      const dead = harness
      harness = null
      if (settled) {
        // 已经在跑了才退出：这是运行期崩溃，不是启动失败。
        if (!quitting) reportHarnessDeath(code, signal, log)
        return
      }
      settled = true
      clearTimeout(timer)
      reject(new Error(`harness 未能启动就退出了（code ${code}${signal ? `, signal ${signal}` : ''}）。\n\n输出：\n${log.slice(-2000)}`))
      void dead
    })
  })
}

/**
 * 结束 harness 及其子孙进程。
 * Windows 上 child.kill() 只结束被 spawn 的那一个，tsx 之下的进程会留成孤儿，
 * 端口也跟着不放；taskkill /T 才是这里唯一可靠的做法。
 */
function stopHarness() {
  const child = harness
  if (child === null || child.pid === undefined) return
  harness = null
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  child.kill('SIGTERM')
}

/** 运行期崩溃：告诉用户发生了什么，而不是留一个白窗口。 */
function reportHarnessDeath(code, signal, log) {
  const detail = `退出码 ${code}${signal ? `，信号 ${signal}` : ''}`
  if (win !== null && !win.isDestroyed()) win.destroy()
  dialog.showErrorBox('DeepSeek Harness 已停止', `后台服务意外退出（${detail}）。\n\n最后的输出：\n${log.slice(-1500)}`)
  app.quit()
}

// ---------------------------------------------------------------- IPC 载体（方案 B 验证）

/** 当前 harness 的 origin；IPC 桥要用，窗口关掉也不影响它的有效性。 */
let harnessOrigin = null

/**
 * 渲染进程 → 主进程 → harness 的 unary 调用。
 *
 * 这一版仍然把请求转发到子进程的 HTTP 端点，因为 harness 现在是独立进程，主进程
 * 手里没有 `ctx.apiProxy` 对象。方案 B 落地时这里换成
 * `toFetchHandler(ctx.apiProxy).fetch(request)` —— 渲染侧的接口一个字都不用改，
 * 这正是验证要证明的：载体是可替换的，协议不受影响。
 *
 * 关键在请求头的形状，而不是它走了哪条线：
 *  - Host 由 URL 自动填成 127.0.0.1:<port>，是回环权威 → 过 Host 栅栏
 *  - 不带 Origin、不带 Sec-Fetch-* → 过跨站栅栏与 Origin 栅栏
 * 因此 PRIVILEGED_METHODS 那道 `isTrustedApiRequest(request, [])` 会**正常放行**，
 * 而不是因为缺少请求头被绕过。真正的 IPC 桥必须合成同样的头，否则特权方法要么
 * 全被拒，要么在一道形同虚设的栅栏后面敞开。
 */
async function callApi(method, payload) {
  if (harnessOrigin === null) return { ok: false, error: 'harness 尚未就绪' }
  if (typeof method !== 'string' || !/^[a-zA-Z]+\.[a-zA-Z]+$/.test(method)) {
    // 方法名直接进 URL 路径，必须先约束形状，否则渲染进程可以拼出任意路径。
    return { ok: false, error: `非法方法名：${String(method)}` }
  }
  const message = { type: 'client-request', rpcId: randomUUID(), method, payload: payload ?? {} }
  try {
    const res = await fetch(`${harnessOrigin}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
    })
    const text = await res.text()
    let body
    try { body = JSON.parse(text) } catch { body = text }
    return { ok: true, status: res.status, body }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) }
  }
}

function registerBridge() {
  ipcMain.handle('dsh:api', (_event, args) => callApi(args?.method, args?.payload))
  ipcMain.handle('dsh:origin', () => harnessOrigin)
}

// ---------------------------------------------------------------- 窗口

function createWindow(origin) {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    // 内容就绪前不显示，避免先闪一下空白底再出界面。
    show: false,
    backgroundColor: '#ffffff',
    title: 'DeepSeek Harness',
    webPreferences: {
      // 渲染进程只加载 harness 自己的前端，不需要 Node 能力；这三项是默认值，
      // 显式写出来是为了让"壳不给页面额外权限"成为一条读得到的约定。
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  win.once('ready-to-show', () => { win?.show() })
  win.on('closed', () => { win = null })

  // 外部链接交给系统浏览器：这个窗口是应用，不是通用浏览器。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // 同理，窗口内的导航不得离开 harness 自己的 origin。
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) {
      event.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  })

  void win.loadURL(origin)
}

/**
 * 载体验证窗口：用 file:// 加载，因此它和方案 B 里真正的渲染进程处境完全一致
 * —— 一个不透明源的页面，除了 preload 那道缝之外没有任何通往宿主的路。
 */
function createSpikeWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 760,
    title: 'IPC 载体验证',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  win.on('closed', () => { win = null })
  void win.loadFile(path.join(__dirname, 'spike.html'))
}

// ---------------------------------------------------------------- 应用生命周期

// 第二个实例没有意义：两个壳会各自拉起一份 harness，抢同一个 DSH_HOME。
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
      const origin = await startHarness()
      harnessOrigin = origin
      registerBridge()
      // DSH_DESKTOP_SPIKE=1 打开载体验证页（file:// 加载）而不是产品界面。
      if (process.env.DSH_DESKTOP_SPIKE === '1') { createSpikeWindow(); return }
      createWindow(origin)
    } catch (err) {
      dialog.showErrorBox('DeepSeek Harness 启动失败', String(err instanceof Error ? err.message : err))
      app.quit()
    }
  })

  app.on('window-all-closed', () => { app.quit() })
  app.on('before-quit', () => { quitting = true; stopHarness() })
  // 壳被强杀时兜底，避免留下占着端口的孤儿进程。
  process.on('exit', stopHarness)
}
