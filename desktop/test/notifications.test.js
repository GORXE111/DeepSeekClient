'use strict'

/**
 * 通知器的行为测试。
 *
 * 重点是**什么时候闭嘴**：这个模块存在的理由是把人叫回来，而一个叫得太勤的提醒
 * 很快就被人整体忽略掉，那时它连真正要紧的审批都提醒不动了。
 *
 * electron 的 Notification 在这里换成替身：真弹通知既没法断言，也会在跑测试的人
 * 屏幕上糊一堆窗。
 *
 * 用法：node desktop/test/notifications.test.js
 */

const path = require('node:path')
const Module = require('node:module')

/* ── electron 替身 ──────────────────────────────────────────────────────── */
const shown = []
class FakeNotification {
  constructor(opts) { this.opts = opts }
  on() {}
  show() { shown.push(this.opts) }
  static isSupported() { return true }
}

const realResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub'
  return realResolve.call(this, request, ...rest)
}
require.cache['electron-stub'] = {
  id: 'electron-stub', filename: 'electron-stub', loaded: true,
  exports: { Notification: FakeNotification },
}

const { createNotifier } = require(path.join(__dirname, '..', 'host', 'notifications.js'))

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra === '' ? '' : '  → ' + extra)) }
}

/**
 * 建一个通知器。
 * @param {object} o
 * @param {boolean} [o.focused] 主窗口是否有焦点
 * @param {string} [o.petId] 宠物会话 id
 */
function setup({ focused = false, petId = 'pet' } = {}) {
  shown.length = 0
  const states = []
  const says = []
  const n = createNotifier({
    getWindow: () => ({ isDestroyed: () => false, isFocused: () => focused }),
    getLocale: () => 'zh',
    onState: (s) => states.push(s),
    onSay: (kind, detail) => says.push([kind, detail]),
    isPetSession: (id) => id === petId,
  })
  return { n, states, says, shown }
}

const status = (sessionId, running) => ({ type: 'host/session-status', sessionId, running })

console.log('1) 正常的一轮：跑起来 → 跑完')
{
  const { n, states } = setup()
  n.observe(status('work', true))
  check('状态变忙', states.at(-1) === 'running', String(states.at(-1)))
  check('开跑不弹通知', shown.length === 0)
  n.observe(status('work', false))
  check('跑完弹一条', shown.length === 1 && shown[0].title === '任务已完成', JSON.stringify(shown[0]))
  check('状态回空闲', states.at(-1) === 'idle', String(states.at(-1)))
}

console.log('2) 基线里的 running:false 不是"刚跑完"')
{
  // 连接建立时会收到一批基线状态帧。不加判断的话每次启动都收到一串假的完成通知。
  const { n } = setup()
  n.observe(status('work', false))
  n.observe(status('other', false))
  check('没见过它跑就不报完成', shown.length === 0, String(shown.length))

  // "见过在跑"这份记录必须是每实例一份。放模块作用域会串味：上面第 1 组测试里
  // 'work' 跑过又停了，若共享，这里的新实例会继承那段历史。
  const fresh = setup()
  fresh.n.observe(status('work', false))
  check('新实例不继承旧实例的历史', shown.length === 0, String(shown.length))
}

console.log('3) 窗口有焦点时不打扰')
{
  const { n, says } = setup({ focused: true })
  n.observe(status('work', true))
  n.observe(status('work', false))
  check('不弹系统通知', shown.length === 0, String(shown.length))
  // 宠物不受这条约束：人就在屏幕前时系统通知反而容易被忽略，桌面角落有个小人
  // 开口说话是更合适的提醒方式。
  check('但仍然告诉宠物', says.some(([k]) => k === 'done'))
}

console.log('4) 宠物那条会话整条不算数')
{
  // 这是修过的一个真 bug：跟桌面摆件说句"在吗"，托盘会显示成忙碌，她答完还会
  // 弹一条"任务已完成 / 智能体已结束本轮工作"。她不是"你的智能体"。
  const { n, states, says } = setup()
  n.observe(status('pet', true))
  check('托盘不变忙', states.length === 0, JSON.stringify(states))
  n.observe(status('pet', false))
  check('不弹完成通知', shown.length === 0, String(shown.length))
  check('也不让宠物说"忙完啦"', says.length === 0, JSON.stringify(says))
}

console.log('5) 宠物的忙碌不会盖掉真智能体的忙碌')
{
  const { n, states } = setup()
  n.observe(status('work', true))
  n.observe(status('pet', true))
  n.observe(status('pet', false))
  check('真智能体还在跑，状态仍是忙', states.at(-1) === 'running', String(states.at(-1)))
  n.observe(status('work', false))
  check('它跑完了才回空闲', states.at(-1) === 'idle', String(states.at(-1)))
  check('只报了它那一条完成', shown.length === 1, String(shown.length))
}

console.log('6) 审批与提问：需要你现在处理')
{
  const { n, states } = setup()
  n.observe({ type: 'approval/requested', sessionId: 'work', toolName: 'Bash' })
  check('状态变待处理', states.at(-1) === 'attention', String(states.at(-1)))
  check('弹了审批通知', shown.at(-1)?.title === '需要你批准', JSON.stringify(shown.at(-1)))
  check('说清是哪个工具', String(shown.at(-1)?.body).includes('Bash'), String(shown.at(-1)?.body))
  n.observe({ type: 'approval/resolved', sessionId: 'work' })
  check('处理完回空闲', states.at(-1) === 'idle', String(states.at(-1)))
}

console.log('7) 宠物不会请求审批，就算来了也不算数')
{
  // 宠物预设没有任何工具，理论上不会有这种帧。挡住是因为"理论上不会"不是保证。
  const { n, states } = setup()
  n.observe({ type: 'approval/requested', sessionId: 'pet', toolName: 'Bash' })
  check('不弹', shown.length === 0, String(shown.length))
  check('状态不动', states.length === 0, JSON.stringify(states))
}

console.log('8) 出错')
{
  const { n, states } = setup()
  n.observe({ type: 'host/agent-error', sessionId: 'work', message: '模型返回 500' })
  check('弹了错误通知', shown.at(-1)?.title === '智能体出错')
  check('带上原因', String(shown.at(-1)?.body).includes('500'))
  check('状态变待处理', states.at(-1) === 'attention')
  n.clearAttention()
  check('窗口回到前台就消掉红点', states.at(-1) === 'idle', String(states.at(-1)))
}

console.log('9) 坏数据不能带倒载体')
{
  const { n } = setup()
  const survives = (label, payload) => {
    try { n.observe(payload); check(label, true) } catch (e) { check(label, false, String(e.message)) }
  }
  survives('null', null)
  survives('数字', 7)
  survives('字符串', 'nope')
  survives('空对象', {})
  survives('认不得的类型', { type: '天知道' })
  survives('缺 sessionId', { type: 'host/session-status', running: true })
}

console.log()
console.log(fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
