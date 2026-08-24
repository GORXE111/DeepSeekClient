'use strict'

/**
 * 应用菜单与界面语言。
 *
 * 刻意只保留两样东西：语言切换，和一个编辑菜单。
 *
 * 编辑菜单不是可选项 —— macOS 的 Cmd+C/V/X/A 快捷键是从菜单项的 role 上取的，
 * 删掉它复制粘贴就真的不工作，而不只是少了几个菜单项。重新加载、缩放、开发者
 * 工具这些则是开发用的，产品里不该出现。
 *
 * 按平台摆放：macOS 的第一个菜单必须是应用名，关于/服务/隐藏/退出落在它下面
 * —— 那是系统约定，放错比没有菜单更显业余；Windows 上没有应用菜单，语言与
 * 退出就得另有去处。
 *
 * 语言不另起一套：上游前端自带 i18n（设置 → 语言），菜单把同一个设置写过去，
 * 两个入口共用一份状态。菜单自己那份文案的选择记在 userData 下，只为下次启动
 * 能先摆出正确的菜单，不等运行时就绪。
 *
 * @module menu
 */

const { app, Menu, dialog } = require('electron')
const { ACCENTS, accentById } = require('./accents.js')
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
    edit: '编辑',
    undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选',
    language: '语言', chinese: '简体中文', english: 'English',
    appearance: '强调色',
    pet: '宠物模式',
    about: '关于 DeepSeek Client', services: '服务',
    hide: '隐藏', hideOthers: '隐藏其他', unhide: '全部显示', quit: '退出',
    restartHint: '菜单语言已切换，但界面语言没能同步。',
    restartTitle: '语言未完全切换',
  },
  en: {
    edit: 'Edit',
    undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All',
    language: 'Language', chinese: '简体中文', english: 'English',
    appearance: 'Accent',
    pet: 'Pet Mode',
    about: 'About DeepSeek Client', services: 'Services',
    hide: 'Hide', hideOthers: 'Hide Others', unhide: 'Show All', quit: 'Quit',
    restartHint: 'The menu language changed, but the interface language could not be synced.',
    restartTitle: 'Language Not Fully Applied',
  },
}

/**
 * 装上菜单。
 * @param {(locale: 'zh' | 'en') => void | Promise<void>} applyLocale
 *   把语言写进 harness 的 locale 设置。菜单只负责发出意图，怎么送到运行时是
 *   调用方的事 —— 这个模块不该知道管道的存在。
 */
function currentAccent() {
  return accentById(readPrefs().accent).id
}

function petEnabled() {
  return readPrefs().pet === true
}

function installMenu(applyLocale, applyAccent, togglePet) {
  const locale = currentLocale()
  const t = STRINGS[locale]
  const mac = process.platform === 'darwin'

  const languageSubmenu = [
    {
      label: t.chinese,
      type: 'radio',
      checked: locale === 'zh',
      click: () => { switchLocale('zh', applyLocale, applyAccent, togglePet) },
    },
    {
      label: t.english,
      type: 'radio',
      checked: locale === 'en',
      click: () => { switchLocale('en', applyLocale, applyAccent, togglePet) },
    },
  ]

  // 强调色只改两个别名令牌，切换是即时的 —— 所以不必提示重启，点完就该看见变化。
  const accent = currentAccent()
  const appearanceSubmenu = ACCENTS.map((a) => ({
    label: locale === 'zh' ? a.zh : a.en,
    type: 'radio',
    checked: accent === a.id,
    click: () => {
      writePrefs({ ...readPrefs(), accent: a.id })
      installMenu(applyLocale, applyAccent, togglePet)
      applyAccent?.(a.id)
    },
  }))

  // 宠物模式默认关闭：一个会浮在别人所有窗口之上的东西，不该装完就自己冒出来。
  const petItem = {
    label: t.pet,
    type: 'checkbox',
    checked: petEnabled(),
    click: (item) => {
      writePrefs({ ...readPrefs(), pet: item.checked })
      togglePet?.(item.checked)
    },
  }

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = []

  // macOS 的第一个菜单必须是应用名，系统会把关于/服务/隐藏/退出认到这里。
  if (mac) {
    template.push({
      label: app.name,
      submenu: [
        { label: t.about, role: 'about' },
        { type: 'separator' },
        { label: t.language, submenu: languageSubmenu },
        { label: t.appearance, submenu: appearanceSubmenu },
        petItem,
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

  // 编辑菜单不能省。macOS 的 Cmd+C/V/X/A 快捷键是从菜单项的 role 上取的 ——
  // 删掉这个菜单，复制粘贴就真的不工作了，而不只是少了几个菜单项。
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

  // 非 macOS 上没有应用菜单，语言与退出得有个去处。
  if (!mac) {
    template.push({ label: t.language, submenu: languageSubmenu })
    template.push({
      label: t.appearance,
      submenu: [...appearanceSubmenu, { type: 'separator' }, petItem, { type: 'separator' }, { label: t.quit, role: 'quit' }],
    })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * 切换语言。
 *
 * 上游前端自己带 i18n（设置 → 语言），存在 `locale` 命名空间的 `preference`
 * 字段里。所以这里不另起一套：菜单把同一个设置写过去，界面立刻跟着变，菜单
 * 文字也一并重建。两个入口、一份状态。
 *
 * 早先这里只换菜单文字并提示重启 —— 那等于给用户两个语言开关，其中一个还不
 * 管用。发现上游已有之后就没有理由那么做了。
 */
function switchLocale(next, applyLocale, applyAccent, togglePet) {
  if (currentLocale() === next) return
  writePrefs({ ...readPrefs(), locale: next })
  installMenu(applyLocale, applyAccent, togglePet)
  Promise.resolve(applyLocale?.(next)).catch((err) => {
    // 界面没跟着变的话要说出来，否则用户只会觉得"点了没用"。
    void dialog.showMessageBox({
      type: 'warning',
      title: STRINGS[next].restartTitle,
      message: STRINGS[next].restartHint,
      detail: String(err && err.message ? err.message : err),
    })
  })
}

module.exports = { installMenu, currentLocale, currentAccent, petEnabled, readPrefs, writePrefs, STRINGS }
