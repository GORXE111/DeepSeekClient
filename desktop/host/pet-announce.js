'use strict'

/**
 * 决定「这一轮值不值得吱一声」，以及「几件事该合成一句还是分开说」。
 *
 * 没有这一层的时候，别的智能体每收工一轮宠物就弹一次气泡。连着问几个小问题，
 * 就是连着三四个气泡糊在屏幕角上 —— 而且后一个会把前一个顶掉，等于一条都没
 * 看清。提醒的价值来自稀缺，每轮都提醒等于没提醒。
 *
 * 两道闸：
 *
 *  1. **门槛** —— 随口一问不值得打断你。判据是"这轮到底干没干活"：调过工具、
 *     跑得够久、或者答得够长，三者有其一才算。三条都是"活儿"的不同表征，用或
 *     而不是与：一个跑了两分钟没调工具的深度问答是活儿，一个瞬间返回但调了五
 *     次工具的批量改名也是活儿。
 *
 *  2. **合流** —— 过了门槛也不立刻说。先攒一小会儿，把这段时间里收工的都并成
 *     一句；说完再静默一段，静默期内新来的继续攒。于是"三个会话几乎同时收工"
 *     得到一句话而不是三个气泡，"每隔十秒收一轮"也不会变成刷屏。
 *
 * 单独成模块是为了能直接测：这里每一条规则都要么等几十秒、要么要开好几个会话
 * 才能在真机上复现一次，留在 main.js 里就只能靠读代码相信它。
 *
 * @module pet-announce
 */

/** 低于这个时长、又没别的迹象，就当是随口一问。 */
const MIN_DURATION_MS = 20000

/** 答得够长也算干了活 —— 长文本身就是工作量，哪怕一个工具都没调。 */
const MIN_ANSWER_CHARS = 600

/** 攒多久再说。够短，不至于让人觉得"干完了怎么没动静"；够长，能接住并发收工。 */
const BATCH_MS = 4000

/** 说完之后的静默期。这段时间里收工的攒着，到点一起说。 */
const QUIET_MS = 15000

/**
 * 这一轮算不算正经活。
 *
 * @param {{tools?: number, durationMs?: number, answer?: string}} digest 一轮的摘要素材
 * @param {{minDurationMs?: number, minAnswerChars?: number}} [limits] 阈值，测试时可注入
 * @returns {boolean} true 表示值得吱一声
 */
function isWorthAnnouncing(digest, limits = {}) {
  if (digest === null || typeof digest !== 'object') return false
  const minDuration = limits.minDurationMs ?? MIN_DURATION_MS
  const minAnswer = limits.minAnswerChars ?? MIN_ANSWER_CHARS
  if (Number(digest.tools) > 0) return true
  if (Number(digest.durationMs) >= minDuration) return true
  return String(digest.answer ?? '').length >= minAnswer
}

/**
 * 建一个合流器。
 *
 * 时刻和定时器都从外面拿：这里的行为全部由时间定义，用真的 Date.now 和
 * setTimeout 测就得真等上几十秒，那样的测试没人会跑第二遍。
 *
 * @param {object} deps
 * @param {(digests: object[]) => void} deps.emit 到点了，把攒下的这批交出去（至少一条）
 * @param {() => number} [deps.now]
 * @param {(fn: () => void, ms: number) => unknown} [deps.setTimer]
 * @param {(id: unknown) => void} [deps.clearTimer]
 * @param {number} [deps.batchMs]
 * @param {number} [deps.quietMs]
 * @param {number} [deps.minDurationMs]
 * @param {number} [deps.minAnswerChars]
 */
function createAnnouncer({
  emit,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  batchMs = BATCH_MS,
  quietMs = QUIET_MS,
  minDurationMs = MIN_DURATION_MS,
  minAnswerChars = MIN_ANSWER_CHARS,
} = {}) {
  /** 等着一起说出去的素材。 */
  let pending = []

  /** 上一次真正开口的时刻。−Infinity 表示还没说过，第一次不受静默期约束。 */
  let lastEmit = -Infinity

  let timer = null

  const fire = () => {
    timer = null
    if (pending.length === 0) return
    const batch = pending
    pending = []
    lastEmit = now()
    emit(batch)
  }

  /**
   * 交一条摘要进来。不够格的直接丢，够格的排进队里等合流。
   *
   * @param {object} digest 一轮的摘要素材
   * @returns {boolean} 是否被接受（仅表示过了门槛，不表示已经说出去）
   */
  const offer = (digest) => {
    if (!isWorthAnnouncing(digest, { minDurationMs, minAnswerChars })) return false
    pending.push(digest)
    // 目标时刻取两者之晚：攒够 batchMs，且离上次开口够 quietMs。已经排了队就不
    // 重排 —— 每来一条都往后推的话，持续不断的收工会让这批永远说不出口。
    if (timer === null) {
      const due = Math.max(now() + batchMs, lastEmit + quietMs)
      timer = setTimer(fire, Math.max(0, due - now()))
    }
    return true
  }

  /** 立刻把攒着的说掉（应用要退出、或用户主动点了宠物时用）。 */
  const flush = () => {
    if (timer !== null) { clearTimer(timer); timer = null }
    fire()
  }

  /** 丢掉攒着的，不说了。 */
  const cancel = () => {
    if (timer !== null) { clearTimer(timer); timer = null }
    pending = []
  }

  /** 队里现在攒了几条。给测试和调试用。 */
  const size = () => pending.length

  return { offer, flush, cancel, size }
}

/** 任务名在气泡里的长度上限。再长就把一行撑爆，而气泡只有两行高。 */
const MAX_BRIEF_CHARS = 22

/** 一次最多列几件事。列满屏等于没列，剩下的用一句"还有 N 件"带过。 */
const MAX_LISTED = 4

/**
 * 把一件事的原话压成一个短标题。
 *
 * 折掉所有空白再截断：提问经常是多行的，原样带进气泡会把一句话撑成半屏。
 *
 * @param {string} prompt 用户当时的原话
 * @returns {string} 短标题；原话为空时返回空串
 */
function brief(prompt) {
  const flat = String(prompt ?? '').replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  return flat.length > MAX_BRIEF_CHARS ? `${flat.slice(0, MAX_BRIEF_CHARS)}…` : flat
}

/**
 * 拼出宠物要说的那句话。
 *
 * 只报事实：任务是什么（你自己提的那句话，不可能错）、它完成了。**不经过模型** ——
 * 早先是把那一轮的问答喂给宠物让它转述，结果总结与实际不符：一个小模型隔着一份被
 * 截断的素材去转述另一个模型的工作，说错是常态而不是意外，而说错的代价是你以为
 * 任务成了。要看内容就去主界面，那里有完整原文。
 *
 * @param {object[]} digests 这一批收工的事，至少一条
 * @param {string} nickname 用户设的昵称；空串表示不称呼
 * @param {boolean} zh 是否中文
 * @returns {string} 气泡文本；没有可说的返回空串
 */
function composeAnnouncement(digests, nickname, zh) {
  const list = Array.isArray(digests) ? digests : []
  if (list.length === 0) return ''
  // 编一个占位（"用户""你好"）比不称呼更糟。
  const address = nickname === '' ? '' : (zh ? `${nickname}，` : `${nickname}, `)

  if (list.length === 1) {
    const one = brief(list[0]?.prompt)
    if (one === '') return address + (zh ? '刚才那轮任务搞定啦~' : 'that task is done~')
    return address + (zh ? `你的「${one}」任务搞定啦~` : `your task “${one}” is done~`)
  }

  const head = address + (zh ? `你的 ${list.length} 个任务都搞定啦~` : `all ${list.length} of your tasks are done~`)
  const names = list.map((d) => brief(d?.prompt)).filter((b) => b !== '')
  if (names.length === 0) return head
  const shown = names.slice(0, MAX_LISTED).map((b) => `· ${b}`)
  const rest = names.length - shown.length
  if (rest > 0) shown.push(zh ? `· 还有 ${rest} 件` : `· and ${rest} more`)
  return [head, ...shown].join(String.fromCharCode(10))
}

module.exports = {
  createAnnouncer,
  isWorthAnnouncing,
  composeAnnouncement,
  brief,
  MIN_DURATION_MS,
  MIN_ANSWER_CHARS,
  BATCH_MS,
  QUIET_MS,
}
