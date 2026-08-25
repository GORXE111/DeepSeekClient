'use strict'

/**
 * 宠物记忆的过期规则。
 *
 * 宠物的记忆是**暂时的**：随口问的东西不该在几天后还压在上下文里影响回答。跨过
 * 本地日历日就换一个会话，昨天的事就此翻篇。
 *
 * 与压缩是两件事，不要混。一天之内上下文涨满由 harness 自己处理 —— 标准预设挂了
 * compaction-basic，它在步骤边界按压力自动压缩并保留摘要。那是"把旧事压成一句
 * 话"，这里是"到点忘掉"；重复实现只会互相打架。
 *
 * 单独成模块是为了能被直接调用验证：跨天这条分支等一天才触发一次，留在主进程里
 * 就只能靠读代码相信它。
 *
 * @module pet-memory
 */

/**
 * 本地日历日。
 *
 * 用本地时间而不是 UTC：用户说的"每天"是他所在时区的每天，UTC 会让身处东八区的
 * 人在早上八点莫名其妙地被清空一次记忆。
 *
 * @param {Date} [now] 当前时间，测试时可注入
 * @returns {string} 形如 `2026-8-25` 的本地日期键
 */
function localDay(now = new Date()) {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
}

/**
 * 是否该翻篇。
 *
 * @param {{day: string} | null} session 当前宠物会话，未建立时为 null
 * @param {string} today 今天的日期键
 * @returns {boolean} true 表示该丢掉旧会话另起一个
 */
function shouldRoll(session, today) {
  return session !== null && session.day !== today
}

module.exports = { localDay, shouldRoll }
