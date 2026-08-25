'use strict'

/**
 * 宠物会话的身份与过期规则：**哪一条是当前这条**，以及**其余的怎么办**。
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

/**
 * 从会话列表里挑出该收起来的宠物会话。
 *
 * 宠物会话不登记工作区，于是落进侧边栏的"未分组"那一栏 —— 跟桌面摆件说的话不该
 * 在那里占位置。上游给的唯一隐藏手段是归档（workspace.archiveSession）：会话照常
 * 活着、照常收发，只是不在任何分组界面出现。
 *
 * 按 cwd 认而不是按记下来的 id 认：记下来的只有最新那条，而早先版本每次启动都另起
 * 一条，那些正是要清掉的。
 *
 * 单拎出来是因为它踩过一次：线上的会话摘要用的字段是 `sessionId`，客户端内部那层
 * 归一化后的形状才叫 `id`。取错字段不报错，只是得到一串 undefined，然后整批归档
 * 静静地失败。
 *
 * @param {readonly object[]} items `session.list` 返回的摘要数组
 * @param {Iterable<string>} archivedIds 已经归档的 id，重复归档没必要
 * @param {string} petDir 宠物工作目录
 * @param {(p: string) => string} canonical 路径归一化（大小写、分隔符、相对段）
 * @returns {string[]} 该归档的会话 id
 */
function strayPetSessions(items, archivedIds, petDir, canonical) {
  const target = canonical(petDir)
  const archived = new Set(archivedIds)
  const out = []
  for (const item of Array.isArray(items) ? items : []) {
    if (item === null || typeof item !== 'object') continue
    const { sessionId, cwd } = item
    if (typeof sessionId !== 'string' || sessionId === '') continue
    if (typeof cwd !== 'string' || cwd === '') continue
    if (canonical(cwd) !== target) continue
    if (archived.has(sessionId)) continue
    out.push(sessionId)
  }
  return out
}

module.exports = { localDay, shouldRoll, strayPetSessions }
