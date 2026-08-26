'use strict'

/**
 * 宠物记忆过期规则的测试。
 *
 * 跨天这条分支一天只触发一次，留在主进程里就只能靠读代码相信它 —— 模块单独拆
 * 出来正是为了能在这里一步跨过去。
 *
 * 用法：node desktop/test/pet-memory.test.js
 */

const { localDay, shouldRoll, strayPetSessions } = require('../host/pet-memory.js')

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

console.log('3) 该从"未分组"里收起来的是哪些')
{
  // 大小写 + 分隔符都归一化，模拟 Windows 上 path.resolve().toLowerCase()。
  const canon = (p) => p.split(String.fromCharCode(92)).join('/').replace(/[/]+$/, '').toLowerCase()
  const PET = 'C:/Users/admin/.dsh/pet'
  const rows = [
    { sessionId: 's1', cwd: 'C:/Users/admin/.dsh/pet' },
    { sessionId: 's2', cwd: 'E:/DEEPSEEKTest' },
    { sessionId: 's3', cwd: 'C:' + '\\' + 'Users' + '\\' + 'admin' + '\\' + '.dsh' + '\\' + 'pet' },  // 反斜杠
    { sessionId: 's4', cwd: 'c:/users/admin/.dsh/PET/' },      // 大小写 + 尾斜杠
  ]
  const got = strayPetSessions(rows, [], PET, canon)
  check('只挑陪伴助手目录下的', got.join(',') === 's1,s3,s4', got.join(','))

  // 每个角色各占一间子目录；更早的版本把会话直接开在根目录里。一次前缀匹配把两代
  // 都收走。
  const nested = [
    { sessionId: 'n1', cwd: PET + '/miku' },
    { sessionId: 'n2', cwd: PET + '/zhuang' },
    { sessionId: 'n3', cwd: PET },                       // 旧版本的扁平会话
    { sessionId: 'n4', cwd: 'C:/Users/admin/.dsh/petulant' },  // 同前缀但不是我们的
    { sessionId: 'n5', cwd: 'C:/Users/admin/.dsh' },      // 根目录的上一层
  ]
  check('角色子目录都收', strayPetSessions(nested, [], PET, canon).join(',') === 'n1,n2,n3',
    strayPetSessions(nested, [], PET, canon).join(','))
  check('同前缀的旁的目录不误收', !strayPetSessions(nested, [], PET, canon).includes('n4'))
  check('上层目录不误收', !strayPetSessions(nested, [], PET, canon).includes('n5'))

  check('已归档的不重复归档', strayPetSessions(rows, ['s1', 's4'], PET, canon).join(',') === 's3',
    strayPetSessions(rows, ['s1', 's4'], PET, canon).join(','))

  // 踩过的那次：线上摘要的字段是 sessionId，客户端归一化后的形状才叫 id。取错字段
  // 不报错，只会得到一串 undefined 然后整批归档失败 —— 所以这里明确挡住。
  check('没有 sessionId 的行跳过', strayPetSessions([{ id: 'x', cwd: PET }], [], PET, canon).length === 0)
  check('cwd 缺失的行跳过', strayPetSessions([{ sessionId: 's' }], [], PET, canon).length === 0)
  check('cwd 是空串的行跳过', strayPetSessions([{ sessionId: 's', cwd: '' }], [], PET, canon).length === 0)
  check('null 行不炸', strayPetSessions([null, { sessionId: 's1', cwd: PET }], [], PET, canon).join(',') === 's1')
  check('传进来不是数组也不炸', strayPetSessions(undefined, [], PET, canon).length === 0)
  check('空列表 → 空结果', strayPetSessions([], [], PET, canon).length === 0)
}

console.log()
console.log(fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
