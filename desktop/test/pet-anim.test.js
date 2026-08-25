'use strict'

/**
 * 宠物动画调度的行为测试。
 *
 * 调度器是内联在 pet.html 里的，所以这里把 <script> 块抠出来丢进 vm 跑，用假
 * 定时器把时间当数据推进 —— 否则光"闲置四分钟后打盹"这一条就要真等四分钟。
 *
 * 用法：node desktop/test/pet-anim.test.js
 */

const fs = require('fs')
const vm = require('vm')
const path = require('path')

const HTML = path.join(__dirname, '..', 'renderer', 'pet.html')

/* ── 假定时器 ───────────────────────────────────────────────────────────── */
let now = 0
let seq = 0
const pending = new Map()

const setTimeoutFake = (fn, ms) => {
  const id = ++seq
  pending.set(id, { at: now + (Number(ms) || 0), fn })
  return id
}
const clearTimeoutFake = (id) => { pending.delete(id) }

/** 把时间推进 ms，沿途按到期顺序触发回调（同刻按注册顺序，保证可复现）。 */
const advance = (ms) => {
  const until = now + ms
  for (;;) {
    let next = null
    for (const [id, t] of pending) {
      if (t.at > until) continue
      if (next === null || t.at < next.at || (t.at === next.at && id < next.id)) next = { id, ...t }
    }
    if (next === null) break
    pending.delete(next.id)
    now = next.at
    next.fn()
  }
  now = until
}

/* ── 假 DOM ─────────────────────────────────────────────────────────────── */
let painted = { anim: null, frame: null }
const ctx = { imageSmoothingEnabled: true, clearRect() {}, drawImage() {} }
const el = () => ({
  addEventListener() {}, focus() {}, style: {}, value: '', textContent: '',
  classList: { add() {}, remove() {}, contains: () => false },
})
const canvas = { ...el(), getContext: () => ctx, width: 0, height: 0 }
const nodes = { tank: el(), bubble: el(), panel: el(), input: el(), send: el(), cv: canvas }

const sandbox = {
  document: {
    body: { classList: { add() {}, remove() {}, contains: () => false } },
    documentElement: { style: { setProperty() {} } },
    getElementById: (id) => nodes[id],
  },
  window: { addEventListener() {} },
  setTimeout: setTimeoutFake,
  clearTimeout: clearTimeoutFake,
  requestAnimationFrame: (fn) => setTimeoutFake(fn, 16),
  console, Math, Set, Map, JSON, Number, String, Promise, Object,
}
sandbox.globalThis = sandbox
sandbox.window.__dshPet = { resize: async () => {}, moveBy() {}, menu() {}, ask: async () => ({ ok: true }) }

// 精灵表替身：不解码 PNG，只把"画了哪条的第几帧"记下来。动画名必须和真素材一致，
// 否则测试会放过 pet-sprite.js 里写错的名字。
sandbox.__dshSprite = {
  FRAME: 64,
  FRAMES: 4,
  ANIMS: ['idle', 'thinking', 'happy', 'sad', 'wave', 'clap', 'shy', 'sleepy'],
  load: () => Promise.resolve(),
  draw: (_ctx, anim, frame) => { painted = { anim, frame } },
}

const html = fs.readFileSync(HTML, 'utf8')
const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
vm.createContext(sandbox)
new vm.Script(code, { filename: 'pet.html' }).runInContext(sandbox)

/* ── 断言 ───────────────────────────────────────────────────────────────── */
let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra === '' ? '' : '  → ' + extra)) }
}
const at = () => painted.anim + '#' + painted.frame

async function main() {
  const W = sandbox.window
  // 首帧是在 load() 的 then 里画的 —— 那是个微任务，得先让它排空。
  await new Promise((r) => setImmediate(r))

  console.log('1) 起步就是 idle')
  check('首帧画的是 idle', painted.anim === 'idle', at())

  console.log('2) idle 自己会动，一轮眨完停下来')
  const seen = new Set()
  for (let i = 0; i < 4; i++) { advance(180); seen.add(painted.frame) }
  check('四帧都画过', seen.size === 4, [...seen].join(','))
  check('停在第 0 帧', painted.frame === 0, at())
  advance(2000)                       // 短于最短停顿 2600
  check('停顿期间不换帧', painted.anim === 'idle' && painted.frame === 0, at())
  advance(4000)                       // 长于最长停顿 6000
  check('停顿结束继续眨', painted.anim === 'idle', at())

  console.log('3) 状态推送映射到底色')
  W.__dshPetState('running');   check('running → thinking', painted.anim === 'thinking', at())
  W.__dshPetState('attention'); check('attention → wave', painted.anim === 'wave', at())
  W.__dshPetState('idle');      check('idle → idle', painted.anim === 'idle', at())
  W.__dshPetState(undefined);   check('缺状态回落 idle', painted.anim === 'idle', at())

  console.log('4) 一次性动画放一轮就让位')
  W.__dshPetState('running')
  W.__dshPetPlay('clap')
  check('插播中是 clap', painted.anim === 'clap', at())
  for (let i = 0; i < 3; i++) advance(170)
  check('第 4 帧仍是 clap', painted.anim === 'clap' && painted.frame === 3, at())
  advance(170)
  check('放完落回 thinking 第 0 帧', painted.anim === 'thinking' && painted.frame === 0, at())
  advance(3000)
  check('之后一直是 thinking', painted.anim === 'thinking', at())

  console.log('5) 底色没被改过时，插播落回 idle')
  W.__dshPetState('idle')
  W.__dshPetPlay('happy')
  advance(200 * 4)
  check('落回 idle', painted.anim === 'idle', at())

  console.log('6) 认不得的名字挡掉')
  W.__dshPetPlay('nope');            check('乱名字无效', painted.anim === 'idle', at())
  W.__dshPetPlay('miku-happy.png');  check('文件名无效', painted.anim === 'idle', at())

  console.log('7) 闲久了打盹，一有动静就醒')
  advance(4 * 60 * 1000 + 1000)
  check('4 分钟后 sleepy', painted.anim === 'sleepy', at())
  advance(2000)
  check('sleepy 在循环', painted.anim === 'sleepy', at())
  W.__dshPetPlay('happy')
  check('插播把她叫醒', painted.anim === 'happy', at())
  advance(200 * 4)
  check('放完回 idle 而不是接着睡', painted.anim === 'idle', at())

  console.log('8) 忙的时候不打盹')
  W.__dshPetState('running')
  advance(10 * 60 * 1000)
  check('十分钟后仍是 thinking', painted.anim === 'thinking', at())

  console.log('9) 重复推同一个状态不打断动画')
  advance(260)
  const f1 = painted.frame
  W.__dshPetState('running')
  check('帧号没被复位', painted.frame === f1, painted.frame + ' vs ' + f1)

  console.log('10) 醒着的状态变化会重置打盹计时')
  W.__dshPetState('idle')
  advance(3 * 60 * 1000)
  W.__dshPetState('idle')            // 同状态，但仍算一次"有动静"
  advance(3 * 60 * 1000)
  check('累计 6 分钟但没连续 4 分钟 → 还醒着', painted.anim === 'idle', at())
  advance(2 * 60 * 1000)
  check('再攒够 4 分钟就睡', painted.anim === 'sleepy', at())

  console.log()
  console.log(fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过, ${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
