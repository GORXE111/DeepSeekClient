'use strict'

/**
 * 旁观其他会话，攒出一份"刚才发生了什么"。
 *
 * 鱼不是聊天对象，而是**旁观者**：你和主界面的智能体干活，它在一边看着，等那边收
 * 工再用自己的话总结一波。所以这里只做一件事 —— 把一轮对话压成一份摘要素材，交给
 * 调用方去问鱼。
 *
 * 只认最终消息，不认流式分片：`assistant/chunk` 一轮能有上百条，攒起来既费内存又
 * 会把同一段话重复计入，而 `assistant/message` 是同一内容的定稿。
 *
 * 收工的判据是 `turn/end`，**不是** `host/session-status` 的 running=false。后者走
 * 另一条流，实测会跑在 `assistant/message` 前面 —— 用它触发，摘要里的回答永远是
 * 空的，而鱼会一本正经地报告"那位智能体一个字没吐"。
 *
 * 推理段（`reasoning`）一律丢掉。那是模型的草稿，既不是给人看的，也不该成为另一个
 * 模型总结的输入 —— 让鱼去转述别人的思考过程，只会得到一段更含糊的思考过程。
 *
 * @module pet-observer
 */

/** 摘要素材里正文的上限。再长对总结没有帮助，只是把 token 花在复述上。 */
const MAX_ANSWER_CHARS = 4000

/** 一次提问的上限。 */
const MAX_PROMPT_CHARS = 600

/**
 * 从 content 数组里取出人可读的正文。
 * @param {unknown} content 事件里的 content 数组
 * @returns {string} 拼接后的正文；没有可读部分时为空串
 */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

/**
 * 建一个旁观器。
 *
 * @param {object} deps
 * @param {(sessionId: string) => boolean} deps.isPetSession 判断某个会话是不是鱼自己的
 * @param {(digest: {sessionId: string, prompt: string, answer: string, tools: number}) => void} deps.onDigest
 *   一轮结束且确实有内容时回调
 */
function createPetObserver({ isPetSession, onDigest }) {
  /** @type {Map<string, {prompt: string, answers: string[], tools: number}>} */
  const turns = new Map()

  const slot = (sessionId) => {
    let entry = turns.get(sessionId)
    if (entry === undefined) {
      entry = { prompt: '', answers: [], tools: 0 }
      turns.set(sessionId, entry)
    }
    return entry
  }

  /**
   * 喂一帧。解析失败就丢掉 —— 旁观是附加价值，绝不能因为一帧坏数据影响载体。
   * @param {string} text 一条下行帧的原始文本
   */
  const observe = (text) => {
    let frame
    try { frame = JSON.parse(text)?.payload } catch { return }
    if (frame === null || typeof frame !== 'object') return

    if (frame.type === 'session/event') {
      const sessionId = frame.sessionId
      const event = frame.event
      if (typeof sessionId !== 'string' || event === null || typeof event !== 'object') return
      // 鱼自己那条会话不进素材：它说的话是**结果**，再喂回去就成了自己总结自己。
      if (isPetSession(sessionId)) return

      switch (event.type) {
        case 'user/message': {
          // 新一轮开始，旧素材作废 —— 攒跨轮的内容只会让总结越来越含糊。
          const prompt = textOf(event.data?.content)
          turns.set(sessionId, { prompt: prompt.slice(0, MAX_PROMPT_CHARS), answers: [], tools: 0 })
          return
        }
        case 'assistant/message': {
          const answer = textOf(event.data?.message?.content)
          if (answer !== '') slot(sessionId).answers.push(answer)
          return
        }
        case 'tool/call': {
          slot(sessionId).tools += 1
          return
        }
        case 'turn/end': {
          const entry = turns.get(sessionId)
          turns.delete(sessionId)
          if (entry === undefined) return
          const answer = entry.answers.join(String.fromCharCode(10)).trim()
          // 一轮里既没提问也没回答，多半是重放的历史或空转，没什么可总结的。
          if (entry.prompt === '' && answer === '') return
          onDigest({
            sessionId,
            prompt: entry.prompt,
            answer: answer.slice(0, MAX_ANSWER_CHARS),
            tools: entry.tools,
          })
          return
        }
        default:
          return
      }
    }
  }

  /** 丢掉某个会话的素材（会话被删或应用退出时）。 */
  const forget = (sessionId) => { turns.delete(sessionId) }

  return { observe, forget }
}

module.exports = { createPetObserver, textOf, MAX_ANSWER_CHARS, MAX_PROMPT_CHARS }
