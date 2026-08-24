'use strict'

/**
 * 应用菜单与界面语言。
 *
 * Electron 不给菜单时，Windows 上是没有菜单栏、macOS 上是一份英文默认菜单
 * （"Electron / File / Edit …"），两边都不像一个正经产品。这里给出中英两份，
 * 并按平台摆放：macOS 的第一个菜单必须是应用名，且"关于/服务/隐藏/退出"要落在
 * 它下面 —— 那是系统约定，放错位置比没有菜单更显业余。
 *
 * 语言选择存在 userData 下，与 harness 自己的设置分开：这是壳的偏好，不该混进
 * 用户的 harness 配置里。
 *
 * @module menu
 */

const { app, Menu, shell, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

/** 壳自己的偏好文件。与 harness 的 settings.yaml 无关，故意分开。 */
const prefsPath = () => path.join(app.getPath('userData'), 'shell-prefs.json')

/** 读偏好；文件不存在或坏了都回落到默认，不让一个坏文件挡住启动。 */
function readPrefs() {
  try { return JSON.parse(fs.readFileSync(prefsPath(), 'utf8')) } catch { return {} }
}

function writePrefs(next) {
  try {
    fs.mkdirSync(path.dirname(prefsPath()), { recursive: true })
    fs.writeFileSync(prefsPath(), JSON.stringify(next, null, 2))
  } catch (err) {
    // 存不下就只影响下次启动的语言，不该打断当前操作。
    console.error('[menu] 偏好写入失败:', err)
  }
}

/**
 * 当前界面语言。首次启动跟随系统而不是写死中文：
 * 一个中文用户和一个英文用户拿到的应当都是自己看得懂的那份。
 */
function currentLocale() {
  const saved = readPrefs().locale
  if (saved === 'zh' || saved === 'en') return saved
  return app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

const STRINGS = {
  zh: {
    file: '文件', edit: '编辑', view: '视图', window: '窗口', help: '帮助',
    language: '界语言', chinese: '简体中文', english: 'English',
    newSession: '新建会话', close: '关闭窗口', quit: '退出',
    undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选',
    reload: '重新加载', forceReload: '强制重新加载', devtools: '开发者工具',
    resetZoom: '实际大小', zoomIn: '放大', zoomOut: '缩小', fullscreen: '全屏',
    minimize: '最小化', zoom: '缩放', front: '前置全部窗口',
    about: '关于 DeepSeek Harness', services: '服务', hide: '隐藏', hideOthers: '隐藏其他', unhide: '全部显示',
    upstream: '上游项目', findings: '架构说明',
    restartHint: '界面语言已切换，重启后生效。',
    restartTitle: '需要重启',
  },
  en: {
    file: 'File', edit: 'Edit', view: 'View', window: 'Window', help: 'Help',
    language: 'Language', chinese: '简体中文', english: 'English',
    newSession: 'New Session', close: 'Close Window', quit: 'Quit',
    undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All',
    reload: 'Reload', forceReload: 'Force Reload', devtools: 'Developer Tools',
    resetZoom: 'Actual Size', zoomIn: 'Zoom In', zoomOut: 'Zoom Out', fullscreen: 'Toggle Full Screen',
    minimize: 'Minimize', zoom: 'Zoom', front: 'Bring All to Front',
    about: 'About DeepSeek Harness', services: 'Services', hide: 'Hide', hideOthers: 'Hide Others', unhide: 'Show All',
    upstream: 'Upstream Project', findings: 'Architecture Notes',
    restartHint: 'The interface language will change after a restart.',
    restartTitle: 'Restart Required',
  },
}

/**
 * 装上菜单。
 * @param {() => void} onRelaunchNeeded - 语言切换后由调用方决定怎么提示/重启。
 */
function installMenu(onRelaunchNeeded) {
  const locale = currentLocale()
  const t = STRINGS[locale]
  const mac = process.platform === 'darwin'

  const languageSubmenu = [
    {
      label: t.chinese,
      type: 'radio',
      checked: locale === 'zh',
      click: () => { switchLocale('zh', onRelaunchNeeded) },
    },
    {
      label: t.english,
      type: 'radio',
      checked: locale === 'en',
      click: () => { switchLocale('en', onRelaunchNeeded) },
    },
  ]

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = []

  // macOS 的第一个菜单必须是应用名，系统会把"关于/服务/隐藏/退出"认到这里。
  if (mac) {
    template.push({
      label: app.name,
      submenu: [
        { label: t.about, role: 'about' },
        { type: 'separator' },
        { label: t.language, submenu: languageSubmenu },
        { type: 'separator' },
        { label: t.services, role: 'services' },
        { type: 'separator' },
        { label: t.hide, role: 'hide' },
        { label: t.hideOthers, role: 'hideOthers' },
        { label: t.unhide, role: 'unhide' },
        { type: 'separator' },
        { label: t.quit, role: 'quit' },
      ],
    })
  }

  template.push({
    label: t.file,
    submenu: [
      // 非 macOS 上语言与退出落在文件菜单：那里是 Windows 用户找它们的地方。
      ...mac ? [] : [{ label: t.language, submenu: languageSubmenu }, { type: 'separator' }],
      mac ? { label: t.close, role: 'close' } : { label: t.quit, role: 'quit' },
    ],
  })

  template.push({
    label: t.edit,
    submenu: [
      { label: t.undo, role: 'undo' },
      { label: t.redo, role: 'redo' },
      { type: 'separator' },
      { label: t.cut, role: 'cut' },
      { label: t.copy, role: 'copy' },
      { label: t.paste, role: 'paste' },
      { label: t.selectAll, role: 'selectAll' },
    ],
  })

  template.push({
    label: t.view,
    submenu: [
      { label: t.reload, role: 'reload' },
      { label: t.forceReload, role: 'forceReload' },
      { label: t.devtools, role: 'toggleDevTools' },
      { type: 'separator' },
      { label: t.resetZoom, role: 'resetZoom' },
      { label: t.zoomIn, role: 'zoomIn' },
      { label: t.zoomOut, role: 'zoomOut' },
      { type: 'separator' },
      { label: t.fullscreen, role: 'togglefullscreen' },
    ],
  })

  template.push({
    label: t.window,
    submenu: [
      { label: t.minimize, role: 'minimize' },
      ...mac
        ? [{ label: t.zoom, role: 'zoom' }, { type: 'separator' }, { label: t.front, role: 'front' }]
        : [{ label: t.close, role: 'close' }],
    ],
  })

  template.push({
    label: t.help,
    submenu: [
      {
        label: t.upstream,
        click: () => { void shell.openExternal('https://github.com/deepseek-ai/deepseek-harness') },
      },
      {
        label: t.findings,
        click: () => { void shell.openExternal('https://github.com/GORXE111/DeepSeekClient/blob/main/docs/architecture-findings.md') },
      },
    ],
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** 切换语言并落盘。菜单立刻重建，界面其余部分要等重启 —— 如实告知而不是假装已生效。 */
function switchLocale(next, onRelaunchNeeded) {
  if (currentLocale() === next) return
  writePrefs({ ...readPrefs(), locale: next })
  installMenu(onRelaunchNeeded)
  const t = STRINGS[next]
  void dialog.showMessageBox({ type: 'info', title: t.restartTitle, message: t.restartHint })
  onRelaunchNeeded?.()
}

module.exports = { installMenu, currentLocale, STRINGS }
