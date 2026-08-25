'use strict'

/**
 * 悬浮宠物窗：一个常驻在桌面上的小圆点，用颜色和动作说明 agent 在干什么。
 *
 * 它是托盘状态的"看得见的化身"—— 托盘要你去屏幕角落找，宠物就浮在手边。两者
 * 共用同一份状态，不各自推断，否则迟早会出现"托盘说在跑、宠物说空闲"。
 *
 * **默认关闭**。一个会浮在别人所有窗口之上的东西，不该是装完就自己冒出来的；
 * 想要的人去菜单里开。
 *
 * 位置记在偏好里：每次启动都回到屏幕中央，等于每次都要重新挪一遍。
 *
 * @module pet
 */

const { BrowserWindow, Menu, screen } = require('electron')
const path = require('node:path')

/**
 * 三档尺寸。窗口永远贴着当前可见内容，不留透明余量 —— 透明区域一样会拦住
 * 下面的点击，而绕开它要靠 setIgnoreMouseEvents 加逐帧命中测试，复杂且容易漏。
 */
/**
 * 三档窗口尺寸。
 *
 * 气泡这一档按**总结**定大小，而不是按一句"忙完啦" —— 鱼现在的主要输出是三四句
 * 话的总结，380x112 只装得下一句，多出来的会被裁掉且毫无提示。
 */
const BOUNDS = {
  idle: { width: 144, height: 112 },
  bubble: { width: 460, height: 188 },
  open: { width: 480, height: 112 },
}

const LABELS = {
  zh: { open: '打开主窗口', fresh: '开一个新话题' },
  en: { open: 'Open Main Window', fresh: 'Start a New Topic' },
}

/**
 * @param {object} deps
 * @param {string} deps.desktopDir 壳的根目录（用来找 renderer/pet.html）
 * @param {() => 'zh' | 'en'} deps.getLocale
 * @param {() => void} deps.onActivate 点击宠物时做什么（通常是显示主窗口）
 * @param {() => void} deps.onFreshTopic 在宠物专属工作区里另起一个会话
 * @param {{x: number, y: number} | undefined} deps.position 上次的位置
 * @param {(pos: {x: number, y: number}) => void} deps.onMoved 位置变化时落盘
 */
function createPet({ desktopDir, getLocale, onActivate, onFreshTopic, position, onMoved }) {
  // 没有记录过位置时放在右下角，离系统托盘近 —— 那里通常也是最空的一块。
  const fallback = () => {
    const { workArea } = screen.getPrimaryDisplay()
    const s = BOUNDS.idle.width
    return { x: workArea.x + workArea.width - s - 28, y: workArea.y + workArea.height - s - 96 }
  }
  const spot = position ?? fallback()

  const win = new BrowserWindow({
    width: BOUNDS.idle.width,
    height: BOUNDS.idle.height,
    x: spot.x,
    y: spot.y,
    // 透明无边框置顶：这三样缺一个它就不像"浮在桌面上"，而像一个小窗口。
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    // 不进任务栏：它是常驻装饰，不是一个你会去 Alt+Tab 切换的窗口。
    skipTaskbar: true,
    // 不抢焦点：点它之前你正在做的事不该被打断。
    focusable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(desktopDir, 'host', 'pet-preload.js'),
    },
  })

  // 全屏应用之上也要看得见 —— 否则你一进全屏它就等于不存在。
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  void win.loadFile(path.join(desktopDir, 'renderer', 'pet.html'))

  /**
   * 拖完才落盘：拖动过程中每一帧都写文件毫无意义。
   *
   * 必须由移动本身驱动，不能只挂 `moved` 事件 —— Windows 上程序化的
   * `setPosition` **不发** `moved`，而自绘拖拽全靠 setPosition。只听事件的话，
   * 拖到哪里都不会记住，重启后鱼弹回原处，而且过程里没有任何报错。
   */
  let persistTimer
  const schedulePersist = () => {
    clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      if (win.isDestroyed()) return
      const [x, y] = win.getPosition()
      onMoved({ x, y })
    }, 400)
  }
  // 系统发起的移动（比如显示器变更后的重排）仍走事件。
  win.on('moved', schedulePersist)

  const showMenu = () => {
    const t = LABELS[getLocale()] ?? LABELS.en
    // 刻意不放"关闭宠物模式"：右键是高频误触区，把宠物弄丢的代价远大于
    // 省下一次去主菜单的路。关闭入口只留在应用菜单里。
    Menu.buildFromTemplate([
      { label: t.open, click: onActivate },
      { type: 'separator' },
      { label: t.fresh, click: onFreshTopic },
    ]).popup({ window: win })
  }

  return {
    /**
     * 展开或收起。
     *
     * 窗口尺寸变化是瞬时的（系统不给窗口补间），观感全靠页面里的内容动画，
     * 所以顺序有讲究：展开先放大窗口再播进场，收起先播退场再缩窗口。
     *
     * focusable 跟着切换：收起时为 false，点它之前你正在做的事不该被打断；
     * 展开时必须为 true，否则输入框拿不到焦点，打不了字。
     */
    resize: (mode) => {
      if (win.isDestroyed()) return
      const size = BOUNDS[mode] ?? BOUNDS.idle
      const [x, y] = win.getPosition()
      // 只有展开输入时才可获得焦点：气泡和静默态都不该抢走你正在做的事。
      win.setFocusable(mode === 'open')
      win.setBounds({ x, y, ...size })
      if (mode === 'open') win.focus()
    },

    /**
     * 按增量挪窗口。
     *
     * 拖拽自绘而不是交给 `-webkit-app-region: drag`：系统拖拽会把鼠标事件整个吞
     * 掉，页面因此拿不到"正在被拖"这个事实，也就播不了挣扎动画。代价是位置要自
     * 己算，收益是拖拽期间的表现完全归页面管。
     *
     * 收增量而不是绝对坐标：窗口在拖动中不断移动，页面若用窗口内坐标推算目标位
     * 置，每一帧都会和上一帧的移动叠加，鱼会自己飞走。
     */
    moveBy: (dx, dy) => {
      if (win.isDestroyed()) return
      const [x, y] = win.getPosition()
      win.setPosition(Math.round(x + dx), Math.round(y + dy))
      schedulePersist()
    },

    /** 让鱼说一句话。 */
    say: (text, ms) => {
      if (win.isDestroyed()) return
      void win.webContents.executeJavaScript(
        `window.__dshPetSay?.(${JSON.stringify(text)}, ${Number(ms) || 4200})`,
      ).catch(() => { /* 页面还没加载完 */ })
    },

    /** 推一个状态过去；窗口没了就静默忽略。 */
    setState: (state) => {
      if (win.isDestroyed()) return
      void win.webContents.executeJavaScript(
        `window.__dshPetState?.(${JSON.stringify(state)})`,
      ).catch(() => { /* 页面还没加载完 */ })
    },
    handleActivate: onActivate,
    handleMenu: showMenu,
    /** 渲染进程的 IPC 要认得出是哪个窗口发来的。 */
    ownsWebContents: (contents) => !win.isDestroyed() && contents === win.webContents,
    destroy: () => { if (!win.isDestroyed()) win.destroy() },
  }
}

module.exports = { createPet }
