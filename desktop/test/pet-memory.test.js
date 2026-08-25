'use strict'

/**
 * 宠物记忆过期规则的测试。
 *
 * 跨天这条分支一天只触发一次，留在主进程里就只能靠读代码相信它 —— 模块单独拆
 * 出来正是为了能在这里一步跨过去。
 *
 * 用法：node desktop/test/pet-memory.test.js
 */

const { localDay, shouldRoll } = require('../host/pet-memory.js')

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra === '' ? '' : '  → ' + extra)) }
}

console.log('1) 日期键用本地时间')
{
  check('常规日期', localDay(new Date(2026, 7, 25, 13, 0, 0)) === '2026-8-25', localDay(new Date(2026, 7, 25)))
  check('月份不补零但从 1 起', localDay(new Date(2026, 0, 3)) === '2026-1-3', localDay(new Date(2026, 0, 3)))
  // 用本地时间而不是 UTC：用户说的"每天"是他所在时区的每天。取 UTC 会让东八区的
  // 人在早上八点莫名其妙被清空一次记忆。
  const lateNight = new Date(2026, 7, 25, 23, 30, 0)
  check('深夜仍算当天', localDay(lateNight) === '2026-8-25', localDay(lateNight))
  const earlyMorning = new Date(2026, 7, 25, 0, 30, 0)
  check('凌晨仍算当天', localDay(earlyMorning) === '2026-8-25', localDay(earlyMorning))
  check('不给参数也能用', typeof localDay() === 'string' && localDay().includes('-'))
}

console.log('2) 什么时候该翻篇')
{
  check('还没建会话 → 不翻', shouldRoll(null, '2026-8-25') === false)
  check('同一天 → 不翻', shouldRoll({ day: '2026-8-25' }, '2026-8-25') === false)
  check('跨天 → 翻', shouldRoll({ day: '2026-8-24' }, '2026-8-25') === true)
  check('跨年也翻', shouldRoll({ day: '2025-12-31' }, '2026-1-1') === true)
  // 只比字符串是否相等，不比大小 —— 系统时间被往回调时也该翻篇，而不是继续用
  // 一个"未来"的会话。
  check('时间倒退也翻', shouldRoll({ day: '2026-8-26' }, '2026-8-25') === true)
}

console.log()
console.log(fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
