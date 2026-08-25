'use strict'

/**
 * 旁观器的行为测试。
 *
 * 这里验的每一条都对应一次踩过的坑或一处会静默出错的地方：收工判据用错会让摘要
 * 永远是空的，素材不清会慢慢泄漏，而两者在真机上都不报错 —— 只是宠物说得不对，
 * 或者内存慢慢涨。
 *
 * 用法：node desktop/test/pet-observer.test.js
 */

const { createPetObserver, textOf, MAX_TRACKED_SESSIONS } = require('../host/pet-observer.js')

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra === '' ? '' : '  → ' + extra)) }
}

/** 包一条下行帧。 */
const frame = (sessionId, event) => JSON.stringify({ payload: { type: 'session/event', sessionId, event } })
const userMsg = (text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } })
const asstMsg = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
const toolCall = () => ({ type: 'tool/call', data: {} })
const turnEnd = () => ({ type: 'turn/end', data: {} })

/** 建一个旁观器，外加一个能手动推进的时钟。 */
function setup({ isPetSession = () => false } = {}) {
  let now = 0
  const digests = []
  const obs = createPetObserver({ isPetSession, onDigest: (d) => digests.push(d), now: () => now })
  return { obs, digests, tick: (ms) => { now += ms }, at: () => now }
}

console.log('1) 一轮走完，攒出一份素材')
{
  const { obs, digests, tick } = setup()
  obs.observe(frame('a', userMsg('把登录模块重构一下')))
  tick(1500)
  obs.observe(frame('a', toolCall()))
  obs.observe(frame('a', toolCall()))
  obs.observe(frame('a', asstMsg('好了')))
  tick(500)
  check('收工前不出素材', digests.length === 0)
  obs.observe(frame('a', turnEnd()))
  check('收工出一份', digests.length === 1, String(digests.length))
  const d = digests[0]
  check('提问对得上', d.prompt === '把登录模块重构一下', d.prompt)
  check('回答对得上', d.answer === '好了', d.answer)
  check('工具计数对', d.tools === 2, String(d.tools))
  check('时长从提问算到收工', d.durationMs === 2000, String(d.durationMs))
}

console.log('2) 收工判据是 turn/end，不是 assistant/message')
{
  // 这条是真出过事的：早先用 host/session-status 的 running=false 触发，它走另一
  // 条流、会跑在 assistant/message 前面，于是摘要里的回答永远是空的，宠物一本
  // 正经地报告"那位智能体一个字没吐"。
  const { obs, digests } = setup()
  obs.observe(frame('a', userMsg('问题')))
  obs.observe(frame('a', asstMsg('答案')))
  check('只到 assistant/message 还不出素材', digests.length === 0)
  obs.observe(frame('a', turnEnd()))
  check('turn/end 才出，且带着回答', digests.length === 1 && digests[0].answer === '答案')
}

console.log('3) 宠物自己那条会话不进素材')
{
  const { obs, digests } = setup({ isPetSession: (id) => id === 'pet' })
  obs.observe(frame('pet', userMsg('你好')))
  obs.observe(frame('pet', asstMsg('你好呀')))
  obs.observe(frame('pet', turnEnd()))
  check('自己说的话不喂回自己', digests.length === 0, String(digests.length))
}

console.log('4) 多个会话各算各的')
{
  const { obs, digests } = setup()
  obs.observe(frame('a', userMsg('甲')))
  obs.observe(frame('b', userMsg('乙')))
  obs.observe(frame('b', toolCall()))
  obs.observe(frame('a', asstMsg('甲答')))
  obs.observe(frame('b', turnEnd()))
  check('乙先收工', digests.length === 1 && digests[0].prompt === '乙', JSON.stringify(digests[0]))
  check('乙的工具数没算到甲头上', digests[0].tools === 1, String(digests[0].tools))
  obs.observe(frame('a', turnEnd()))
  check('甲随后收工', digests.length === 2 && digests[1].prompt === '甲')
  check('甲没沾到乙的工具数', digests[1].tools === 0, String(digests[1].tools))
}

console.log('5) 新一轮开始，旧素材作废')
{
  const { obs, digests } = setup()
  obs.observe(frame('a', userMsg('第一问')))
  obs.observe(frame('a', asstMsg('第一答')))
  obs.observe(frame('a', userMsg('第二问')))          // 没收工就问了下一句
  obs.observe(frame('a', turnEnd()))
  check('只带第二轮的内容', digests[0].prompt === '第二问' && digests[0].answer === '', JSON.stringify(digests[0]))
}

console.log('6) 空转的一轮不出素材')
{
  const { obs, digests } = setup()
  obs.observe(frame('a', turnEnd()))
  check('凭空收工不出素材', digests.length === 0)
  obs.observe(frame('a', userMsg('')))
  obs.observe(frame('a', turnEnd()))
  check('既没问也没答不出素材', digests.length === 0, String(digests.length))
}

console.log('7) 坏数据不能带倒载体')
{
  const { obs, digests } = setup()
  const survives = (label, text) => {
    try { obs.observe(text); check(label, true) } catch (e) { check(label, false, String(e.message)) }
  }
  survives('不是 JSON', '这不是 json')
  survives('payload 是 null', JSON.stringify({ payload: null }))
  survives('payload 是数字', JSON.stringify({ payload: 7 }))
  survives('缺 event', JSON.stringify({ payload: { type: 'session/event', sessionId: 'a' } }))
  survives('sessionId 不是字符串', frame(42, userMsg('x')))
  survives('认不得的事件类型', frame('a', { type: '天知道', data: {} }))
  survives('content 不是数组', JSON.stringify({ payload: { type: 'session/event', sessionId: 'a', event: { type: 'user/message', data: { content: 'x' } } } }))
  check('坏数据没混出素材来', digests.length === 0, String(digests.length))
}

console.log('8) 推理段丢掉，不转述别人的草稿')
{
  const { obs, digests } = setup()
  obs.observe(frame('a', userMsg('问')))
  obs.observe(frame('a', {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text: '我先想想…' }, { type: 'text', text: '答' }] } },
  }))
  obs.observe(frame('a', turnEnd()))
  check('只留正文', digests[0].answer === '答', digests[0].answer)
}

console.log('9) 半截的会话不会一直堆着')
{
  // user/message 建、turn/end 删，这两件事不保证配对：会话被删、任务被打断、
  // 应用重连，都会留下等不到收尾的素材。没有上限它们就永不释放。
  const { obs, digests } = setup()
  const n = MAX_TRACKED_SESSIONS + 10
  for (let i = 0; i < n; i++) obs.observe(frame('s' + i, userMsg('第 ' + i + ' 个，都不收工')))
  // 最旧的应该已经被挤掉：给它补一个 turn/end 也出不来素材了。
  obs.observe(frame('s0', turnEnd()))
  check('最旧的已被挤掉', digests.length === 0, String(digests.length))
  // 最新的还在。
  obs.observe(frame('s' + (n - 1), turnEnd()))
  check('最新的还留着', digests.length === 1 && digests[0].prompt.startsWith('第 ' + (n - 1)), JSON.stringify(digests[0]))
}

console.log('10) 半路接上的会话，时长只从此刻算')
{
  // 应用是在会话跑到一半时连上的，没见过 user/message。宁可报一个偏短的时长，
  // 也别凭空编一个。
  const { obs, digests, tick } = setup()
  obs.observe(frame('a', toolCall()))       // 第一次见到这个会话
  tick(3000)
  obs.observe(frame('a', asstMsg('答')))
  obs.observe(frame('a', turnEnd()))
  check('仍出素材', digests.length === 1)
  check('时长从见到那刻算起', digests[0].durationMs === 3000, String(digests[0].durationMs))
  check('提问是空的', digests[0].prompt === '')
}

console.log('11) forget')
{
  const { obs, digests } = setup()
  obs.observe(frame('a', userMsg('问')))
  obs.forget('a')
  obs.observe(frame('a', turnEnd()))
  check('忘掉之后收工不出素材', digests.length === 0, String(digests.length))
}

console.log('12) textOf')
{
  check('拼多段', textOf([{ type: 'text', text: '一' }, { type: 'text', text: '二' }]) === '一\n二')
  check('滤掉非文本', textOf([{ type: 'image' }, { type: 'text', text: '一' }]) === '一')
  check('非数组 → 空串', textOf('x') === '')
  check('undefined → 空串', textOf(undefined) === '')
}

console.log()
console.log(fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
