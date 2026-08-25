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

/* preload 的替身。主进程 → 页面那三条走订阅，测试就从订阅口喂进去 —— 直接调
   window.__dshPetState 只能验调度器，验不到"页面到底有没有把订阅接上"。 */
const subs = { state: null, play: null, say: null }
let readyCalls = 0
sandbox.window.__dshPet = {
  resize: async () => {}, moveBy() {}, menu() {}, ask: async () => ({ ok: true }),
  ready: () => { readyCalls++ },
  onState: (fn) => { subs.state = fn },
  onPlay: (fn) => { subs.play = fn },
  onSay: (fn) => { subs.say = fn },
}

/** 主进程推一个状态过来。 */
const pushState = (s) => subs.state(s)
/** 主进程让她插播一条动画。 */
const pushPlay = (a) => subs.play(a)

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
  // 首帧是在 load() 的 then 里画的 —— 那是个微任务，得先让它排空。
  await new Promise((r) => setImmediate(r))

  console.log('1) 起步就是 idle，并向主进程报到')
  check('首帧画的是 idle', painted.anim === 'idle', at())
  // 报到晚于素材解码：早报到，主进程推来的首帧状态会落在还没解码完的画布上。
  check('素材就绪后报到了一次', readyCalls === 1, String(readyCalls))
  check('三条推送都接上了', subs.state !== null && subs.play !== null && subs.say !== null)

  console.log('2) idle 一直循环，0.5 秒一帧')
  const seen = new Set()
  for (let i = 0; i < 4; i++) { advance(500); seen.add(painted.frame) }
  check('四帧都画过', seen.size === 4, [...seen].join(','))
  check('一轮之后回到第 0 帧', painted.frame === 0, at())
  // 不停顿：以前 idle 播完一轮要停 2.6–6 秒，看着像卡住了。
  advance(500)
  check('立刻接着播下一轮', painted.anim === 'idle' && painted.frame === 1, at())
  let ticks = 0
  for (let i = 0; i < 20; i++) { const before = painted.frame; advance(500); if (painted.frame !== before) ticks++ }
  check('十秒里换了 20 帧', ticks === 20, String(ticks))

  console.log('3) 状态推送映射到底色')
  pushState('running');   check('running → thinking', painted.anim === 'thinking', at())
  pushState('attention'); check('attention → wave', painted.anim === 'wave', at())
  pushState('idle');      check('idle → idle', painted.anim === 'idle', at())
  pushState(undefined);   check('缺状态回落 idle', painted.anim === 'idle', at())

  console.log('4) 一次性动画放一轮就让位')
  pushState('running')
  pushPlay('clap')
  check('插播中是 clap', painted.anim === 'clap', at())
  for (let i = 0; i < 3; i++) advance(170)
  check('第 4 帧仍是 clap', painted.anim === 'clap' && painted.frame === 3, at())
  advance(170)
  check('放完落回 thinking 第 0 帧', painted.anim === 'thinking' && painted.frame === 0, at())
  advance(3000)
  check('之后一直是 thinking', painted.anim === 'thinking', at())

  console.log('5) 底色没被改过时，插播落回 idle')
  pushState('idle')
  pushPlay('happy')
  advance(200 * 4)
  check('落回 idle', painted.anim === 'idle', at())

  console.log('6) 认不得的名字挡掉')
  pushPlay('nope');            check('乱名字无效', painted.anim === 'idle', at())
  pushPlay('miku-happy.png');  check('文件名无效', painted.anim === 'idle', at())

  console.log('7) 闲久了打盹，一有动静就醒')
  advance(4 * 60 * 1000 + 1000)
  check('4 分钟后 sleepy', painted.anim === 'sleepy', at())
  advance(2000)
  check('sleepy 在循环', painted.anim === 'sleepy', at())
  pushPlay('happy')
  check('插播把她叫醒', painted.anim === 'happy', at())
  advance(200 * 4)
  check('放完回 idle 而不是接着睡', painted.anim === 'idle', at())

  console.log('8) 忙的时候不打盹')
  pushState('running')
  advance(10 * 60 * 1000)
  check('十分钟后仍是 thinking', painted.anim === 'thinking', at())

  console.log('9) 重复推同一个状态不打断动画')
  advance(260)
  const f1 = painted.frame
  pushState('running')
  check('帧号没被复位', painted.frame === f1, painted.frame + ' vs ' + f1)

  console.log('10) 醒着的状态变化会重置打盹计时')
  pushState('idle')
  advance(3 * 60 * 1000)
  pushState('idle')            // 同状态，但仍算一次"有动静"
  advance(3 * 60 * 1000)
  check('累计 6 分钟但没连续 4 分钟 → 还醒着', painted.anim === 'idle', at())
  advance(2 * 60 * 1000)
  check('再攒够 4 分钟就睡', painted.anim === 'sleepy', at())

  console.log()
  console.log(fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过, ${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
