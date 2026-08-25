'use strict'

/**
 * 宠物窗口几何的测试：三档尺寸切换、气泡按内容长高、以及别把自己顶出屏幕。
 *
 * 这些在真机上只能靠眼睛看，而且要凑齐条件 —— "把宠物拖到屏幕最下面再让她说一段
 * 长话"这种情形，手动复现一次要半分钟，还看不出差了几个像素。
 *
 * electron 在这里换成替身：BrowserWindow 只记录 setBounds 收到了什么，screen 返回
 * 一块固定的工作区。
 *
 * 用法：node desktop/test/pet-window.test.js
 */

const path = require('node:path')
const Module = require('node:module')

/* ── electron 替身 ──────────────────────────────────────────────────────── */

/** 一块 1920×1080 的屏，顶部留 0、底部留 40 当任务栏。 */
const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 }

class FakeWindow {
  constructor(opts) {
    this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height }
    this.focusable = null
    this.destroyed = false
    this.focusCalls = 0
  }
  isDestroyed() { return this.destroyed }
  getBounds() { return { ...this.bounds } }
  getPosition() { return [this.bounds.x, this.bounds.y] }
  setBounds(b) { this.bounds = { ...this.bounds, ...b } }
  setPosition(x, y) { this.bounds.x = x; this.bounds.y = y }
  setFocusable(v) { this.focusable = v }
  focus() { this.focusCalls++ }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  loadFile() { return Promise.resolve() }
  on() {}
  get webContents() { return { send() {}, isDestroyed: () => false } }
}

let lastWindow = null
const electronStub = {
  BrowserWindow: class extends FakeWindow {
    constructor(opts) { super(opts); lastWindow = this }
  },
  Menu: { buildFromTemplate: () => ({ popup() {} }) },
  screen: {
    getPrimaryDisplay: () => ({ workArea: WORK_AREA }),
    getDisplayMatching: () => ({ workArea: WORK_AREA }),
  },
}

const realResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub'
  return realResolve.call(this, request, ...rest)
}
require.cache['electron-stub'] = {
  id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: electronStub,
}

const { createPet } = require(path.join(__dirname, '..', 'host', 'pet.js'))

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra === '' ? '' : '  → ' + extra)) }
}

/** 建一只宠物，放在给定位置。 */
function setup(position = { x: 800, y: 400 }) {
  const pet = createPet({
    desktopDir: path.join(__dirname, '..'),
    getLocale: () => 'zh',
    onActivate() {},
    onFreshTopic() {},
    position,
    onMoved() {},
  })
  return { pet, win: lastWindow }
}

/** 宠物在窗口里垂直居中，所以她的视觉中心就是窗口中心。 */
const centerY = (b) => b.y + b.height / 2

console.log('1) 三档尺寸')
{
  const { pet, win } = setup()
  check('静默是 144×144', win.bounds.width === 144 && win.bounds.height === 144, JSON.stringify(win.bounds))

  pet.resize('open')
  check('展开变宽', win.bounds.width === 496, String(win.bounds.width))
  check('展开时可获得焦点', win.focusable === true)
  check('展开时主动取焦点', win.focusCalls === 1, String(win.focusCalls))

  pet.resize('idle')
  check('收起回到 144', win.bounds.width === 144 && win.bounds.height === 144, JSON.stringify(win.bounds))
  check('收起后不可获得焦点', win.focusable === false)
}

console.log('2) 气泡高度跟着内容走')
{
  const { pet, win } = setup()
  pet.resize('bubble', 200)
  check('用页面报上来的高度', win.bounds.height === 200, String(win.bounds.height))
  check('宽度仍是气泡档的 480', win.bounds.width === 480, String(win.bounds.width))

  pet.resize('bubble', 400)
  check('更长的话给更高的窗口', win.bounds.height === 400, String(win.bounds.height))
}

console.log('3) 高度的上下限')
{
  const { pet, win } = setup()
  // 下限是宠物本身那么高：再矮就把她裁掉了。
  pet.resize('bubble', 20)
  check('短句子也不低于 144', win.bounds.height === 144, String(win.bounds.height))

  // 上限：再高就从"桌面上的一句话"变成"一扇挡事的窗口"。超出的部分气泡里滚。
  pet.resize('bubble', 9999)
  check('长文封顶 520', win.bounds.height === 520, String(win.bounds.height))

  pet.resize('bubble', Number.NaN)
  check('高度是 NaN 时回落到下限', win.bounds.height === 144, String(win.bounds.height))
  pet.resize('bubble', undefined)
  check('没给高度也回落到下限', win.bounds.height === 144, String(win.bounds.height))
}

console.log('4) 长高的时候宠物待在原地')
{
  // 她在窗口里垂直居中。窗口长高时若左上角不动，她会跟着往下滑 —— 一边说话一边
  // 往下挪，看着像在漏气。
  const { pet, win } = setup({ x: 800, y: 400 })
  const before = centerY(win.getBounds())
  pet.resize('bubble', 400)
  check('长高后中心不变', centerY(win.getBounds()) === before, `${centerY(win.getBounds())} vs ${before}`)
  pet.resize('idle')
  check('收回去中心也不变', centerY(win.getBounds()) === before, `${centerY(win.getBounds())} vs ${before}`)
}

console.log('5) 别把自己顶出屏幕')
{
  // 贴着屏幕底边的时候长高，光靠居中会把下半截推到任务栏底下。
  const { pet, win } = setup({ x: 800, y: WORK_AREA.height - 144 })
  pet.resize('bubble', 500)
  const b = win.getBounds()
  check('底边不越界', b.y + b.height <= WORK_AREA.y + WORK_AREA.height, JSON.stringify(b))
  check('顶边不越界', b.y >= WORK_AREA.y, JSON.stringify(b))

  const top = setup({ x: 800, y: 0 })
  top.pet.resize('bubble', 500)
  check('贴着顶边时同样不越界', top.win.bounds.y >= WORK_AREA.y, String(top.win.bounds.y))

  // 靠右边时变宽（144 → 480）会把右半截推出去。
  const right = setup({ x: WORK_AREA.width - 144, y: 400 })
  right.pet.resize('bubble', 200)
  check('右边不越界', right.win.bounds.x + right.win.bounds.width <= WORK_AREA.width,
    JSON.stringify(right.win.getBounds()))
}

console.log('6) 窗口没了之后不再动它')
{
  const { pet, win } = setup()
  win.destroyed = true
  const before = JSON.stringify(win.getBounds())
  pet.resize('bubble', 400)
  pet.moveBy(50, 50)
  check('resize 不动已销毁的窗口', JSON.stringify(win.getBounds()) === before)
  check('moveBy 也不动', JSON.stringify(win.getBounds()) === before)
}

console.log('7) 认不得的档位回落到静默')
{
  const { pet, win } = setup()
  pet.resize('天知道')
  check('回落到 144×144', win.bounds.width === 144 && win.bounds.height === 144, JSON.stringify(win.bounds))
}

console.log()
console.log(fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
