'use strict'

/**
 * 报喜门槛与合流的行为测试。
 *
 * 时间全部是假的：真跑一遍"说完静默 15 秒"要真等 15 秒，而这里有十几条这样的
 * 断言。假定时器把时间变成能一步跨过去的数据。
 *
 * 用法：node desktop/test/pet-announce.test.js
 */

const {
  createAnnouncer, isWorthAnnouncing, composeAnnouncement, brief,
  MIN_DURATION_MS, MIN_ANSWER_CHARS,
} = require('../host/pet-announce.js')

/* ── 假定时器 ───────────────────────────────────────────────────────────── */
function makeClock() {
  let now = 0
  let seq = 0
  const pending = new Map()
  return {
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; pending.set(id, { at: now + (Number(ms) || 0), fn }); return id },
    clearTimer: (id) => { pending.delete(id) },
    advance(ms) {
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
    },
  }
}

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra === '' ? '' : '  → ' + extra)) }
}

/** 一份典型的"随口一问"素材：秒回、没调工具、答得短。 */
const trivial = (over = {}) => ({ sessionId: 's', prompt: '这个函数干嘛的', answer: '取个配置', tools: 0, durationMs: 800, ...over })

/* ── 1. 门槛 ────────────────────────────────────────────────────────────── */
console.log('1) 什么算"干了活"')
check('随口一问 → 不报', !isWorthAnnouncing(trivial()))
check('调过工具 → 报', isWorthAnnouncing(trivial({ tools: 1 })))
check('跑够久 → 报', isWorthAnnouncing(trivial({ durationMs: MIN_DURATION_MS })))
check('差一毫秒 → 不报', !isWorthAnnouncing(trivial({ durationMs: MIN_DURATION_MS - 1 })))
check('答得够长 → 报', isWorthAnnouncing(trivial({ answer: 'x'.repeat(MIN_ANSWER_CHARS) })))
check('答得差一个字 → 不报', !isWorthAnnouncing(trivial({ answer: 'x'.repeat(MIN_ANSWER_CHARS - 1) })))
check('三条是或不是与', isWorthAnnouncing({ tools: 3, durationMs: 0, answer: '' }))
check('null 不炸', !isWorthAnnouncing(null))
check('缺字段不炸', !isWorthAnnouncing({}))

/* ── 2. 合流 ────────────────────────────────────────────────────────────── */
console.log('2) 攒一会儿再说')
{
  const clock = makeClock()
  const said = []
  const a = createAnnouncer({ emit: (b) => said.push(b), ...clock })

  check('不够格的直接丢', a.offer(trivial()) === false)
  check('丢掉的不进队', a.size() === 0)

  a.offer(trivial({ tools: 1, prompt: '甲' }))
  check('刚交进来不立刻说', said.length === 0)
  clock.advance(3999)
  check('攒够之前不说', said.length === 0)
  clock.advance(2)
  check('攒够就说了', said.length === 1, String(said.length))
  check('说的是那一件', said[0].length === 1 && said[0][0].prompt === '甲')
  check('说完队空了', a.size() === 0)
}

console.log('3) 几乎同时收工 → 并成一句')
{
  const clock = makeClock()
  const said = []
  const a = createAnnouncer({ emit: (b) => said.push(b), ...clock })

  a.offer(trivial({ tools: 1, prompt: '甲' }))
  clock.advance(500)
  a.offer(trivial({ tools: 1, prompt: '乙' }))
  clock.advance(500)
  a.offer(trivial({ tools: 1, prompt: '丙' }))
  clock.advance(10000)
  check('只开口一次', said.length === 1, String(said.length))
  check('三件都在里面', said[0].length === 3, String(said[0].length))
}

console.log('4) 持续收工不会把这批无限往后推')
{
  const clock = makeClock()
  const said = []
  const a = createAnnouncer({ emit: (b) => said.push(b), ...clock })
  // 每秒来一条，连来十条。若定时器每次都重排，这批永远说不出口。
  for (let i = 0; i < 10; i++) { a.offer(trivial({ tools: 1, prompt: 'T' + i })); clock.advance(1000) }
  check('中途就开口了', said.length >= 1, String(said.length))
  check('第一批是攒够 4 秒那几条', said[0].length === 4, String(said[0]?.length))
}

console.log('5) 说完有静默期，期间的攒着')
{
  const clock = makeClock()
  const said = []
  const a = createAnnouncer({ emit: (b) => said.push(b), ...clock })

  a.offer(trivial({ tools: 1, prompt: '甲' }))
  clock.advance(4000)
  check('先说了第一条', said.length === 1)

  // 说完 5 秒又来一条：不该立刻再弹，得等静默期满。
  clock.advance(5000)
  a.offer(trivial({ tools: 1, prompt: '乙' }))
  clock.advance(4000)          // 攒够了，但离上次开口才 9 秒
  check('静默期内不开口', said.length === 1, String(said.length))
  check('攒着没丢', a.size() === 1)
  clock.advance(6001)          // 累计超过 15 秒静默期
  check('静默期满才说', said.length === 2, String(said.length))
  check('说的是乙', said[1][0].prompt === '乙')
}

console.log('6) 隔得够远就各说各的')
{
  const clock = makeClock()
  const said = []
  const a = createAnnouncer({ emit: (b) => said.push(b), ...clock })
  for (let i = 0; i < 3; i++) { a.offer(trivial({ tools: 1, prompt: 'T' + i })); clock.advance(60000) }
  check('三次分开说', said.length === 3, String(said.length))
  check('每次都只有一件', said.every((b) => b.length === 1))
}

console.log('7) flush 和 cancel')
{
  const clock = makeClock()
  const said = []
  const a = createAnnouncer({ emit: (b) => said.push(b), ...clock })
  a.offer(trivial({ tools: 1, prompt: '甲' }))
  a.flush()
  check('flush 立刻说掉', said.length === 1)
  a.flush()
  check('队空时 flush 不空说一句', said.length === 1)

  a.offer(trivial({ tools: 1, prompt: '乙' }))
  a.cancel()
  clock.advance(60000)
  check('cancel 之后不再说', said.length === 1, String(said.length))
  check('队也清了', a.size() === 0)
}

/* ── 3. 措辞 ────────────────────────────────────────────────────────────── */
console.log('8) 说出来的那句话')
{
  const one = [{ prompt: '把登录模块重构一下' }]
  check('一件事 + 昵称', composeAnnouncement(one, '老大', true) === '老大，你的「把登录模块重构一下」任务搞定啦~',
    composeAnnouncement(one, '老大', true))
  check('没设昵称就不称呼', composeAnnouncement(one, '', true).startsWith('你的「'),
    composeAnnouncement(one, '', true))
  check('英文', composeAnnouncement([{ prompt: 'refactor login' }], 'boss', false).includes('boss, your task'),
    composeAnnouncement([{ prompt: 'refactor login' }], 'boss', false))

  const three = [{ prompt: '甲' }, { prompt: '乙' }, { prompt: '丙' }]
  const t = composeAnnouncement(three, '老大', true)
  check('多件事报总数', t.startsWith('老大，你的 3 个任务都搞定啦~'), t)
  check('多件事逐条列出', t.includes('· 甲') && t.includes('· 乙') && t.includes('· 丙'), t)

  const many = Array.from({ length: 7 }, (_, i) => ({ prompt: 'T' + i }))
  const m = composeAnnouncement(many, '', true)
  check('最多列 4 条', (m.match(/· T/g) ?? []).length === 4, m)
  check('剩下的带过', m.includes('· 还有 3 件'), m)

  check('空数组返回空串', composeAnnouncement([], '老大', true) === '')
  check('非数组不炸', composeAnnouncement(null, '老大', true) === '')
  check('提问是空的也说得出话', composeAnnouncement([{ prompt: '   ' }], '老大', true) === '老大，刚才那轮任务搞定啦~',
    composeAnnouncement([{ prompt: '   ' }], '老大', true))
}

console.log('9) 短标题')
{
  check('折掉换行', brief('第一行\n第二行') === '第一行 第二行', brief('第一行\n第二行'))
  check('超长截断加省略号', brief('啊'.repeat(40)) === '啊'.repeat(22) + '…')
  check('刚好不截', brief('啊'.repeat(22)) === '啊'.repeat(22))
  check('空白 → 空串', brief('  \n ') === '')
  check('undefined → 空串', brief(undefined) === '')
}

console.log()
console.log(fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
