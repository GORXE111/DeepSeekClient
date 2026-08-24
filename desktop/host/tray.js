'use strict'

/**
 * 托盘图标：不打开窗口也能知道 agent 在干什么。
 *
 * 三种状态各用一枚图标，而不是只换 tooltip —— tooltip 要悬停才看得见，而托盘
 * 的价值恰恰是"扫一眼就知道"。图标由同一份 SVG 渲染出三个配色，所以形状一致，
 * 只有颜色在说话：
 *
 *   idle       灰   没有会话在跑
 *   running    蓝   正在跑
 *   attention  橙   卡住了，等你批准或回答
 *
 * 关窗行为刻意保持"关掉就退出"。托盘常驻应用把关窗改成隐藏是常见做法，但那对
 * 不知情的人是"我明明关了它还在"，属于不请自来的行为改变。托盘在这里只做状态
 * 与快捷入口。
 *
 * @module tray
 */

const { Tray, Menu, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const LABELS = {
  zh: { show: '显示主窗口', quit: '退出', idle: '空闲', running: '运行中', attention: '等待你的处理' },
  en: { show: 'Show Window', quit: 'Quit', idle: 'Idle', running: 'Running', attention: 'Needs your attention' },
}

/**
 * @param {object} deps
 * @param {string} deps.iconDir 存放 tray-*.png 的目录
 * @param {() => import('electron').BrowserWindow | null} deps.getWindow
 * @param {() => 'zh' | 'en'} deps.getLocale
 * @param {() => void} deps.onQuit
 */
function createTray({ iconDir, getWindow, getLocale, onQuit }) {
  const iconFor = (state) => {
    const file = path.join(iconDir, `tray-${state}.png`)
    // 缺图标不该让托盘整个消失：退回主图标，状态改由 tooltip 承担。
    const fallback = path.join(iconDir, 'icon.png')
    const image = nativeImage.createFromPath(fs.existsSync(file) ? file : fallback)
    return image.isEmpty() ? image : image.resize({ width: 16, height: 16 })
  }

  const tray = new Tray(iconFor('idle'))
  let state = 'idle'

  const render = () => {
    const t = LABELS[getLocale()] ?? LABELS.en
    tray.setImage(iconFor(state))
    tray.setToolTip(`DeepSeek Client · ${t[state]}`)
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: t.show,
        click: () => {
          const win = getWindow()
          if (win === null || win.isDestroyed()) return
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        },
      },
      { type: 'separator' },
      { label: t.quit, click: onQuit },
    ]))
  }

  // 单击直接显示窗口：右键才是菜单，这是托盘的通行约定。
  tray.on('click', () => {
    const win = getWindow()
    if (win === null || win.isDestroyed()) return
    if (win.isVisible() && win.isFocused()) { win.hide(); return }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  render()

  return {
    setState: (next) => {
      if (next === state) return
      state = next
      render()
    },
    /** 语言变了要重画菜单文案。 */
    refresh: render,
    destroy: () => { tray.destroy() },
  }
}

module.exports = { createTray }
