'use strict'

/**
 * 对一遍 IPC 两头。
 *
 * 通道是用字符串连起来的：写错一个字、或者删掉发送方却留着监听方，两边都不会
 * 报错 —— 消息只是永远送不到，或者监听器永远等不到人。这类问题在真机上表现为
 * "点了没反应"，而日志里干干净净。
 *
 * 静态对一遍是能做到的最便宜的防线：用正则把两边声明的通道名抠出来做差集。
 * 正则看得懂的只有字面量，所以通道名一律直接写在调用里，不要拼字符串。
 *
 * 用法：node desktop/test/ipc-channels.test.js
 */

const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8')

const mainJs = read('main.js')
const petJs = read('host', 'pet.js')
const petPreload = read('host', 'pet-preload.js')
const appPreload = read('preload.js')
const petHtml = read('renderer', 'pet.html')

const uniq = (a) => [...new Set(a)].sort()
const grab = (src, re) => uniq([...src.matchAll(re)].map((m) => m[1]))
const diff = (a, b) => a.filter((x) => !b.includes(x))

let pass = 0
let fail = 0
const check = (name, missing) => {
  if (missing.length === 0) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + '  → ' + missing.join(', ')) }
}

console.log('1) 页面 → 主进程')
{
  // 两个 preload 一起算：主进程的监听器分属主窗和宠物窗，只比其中一个会误报。
  const sent = uniq([
    ...grab(petPreload, /ipcRenderer\.(?:send|invoke)\('([^']+)'/g),
    ...grab(appPreload, /ipcRenderer\.(?:send|invoke)\('([^']+)'/g),
  ])
  const heard = grab(mainJs, /ipcMain\.(?:on|handle)\('([^']+)'/g)
  check('preload 发的，主进程都接着', diff(sent, heard))
  // 反向同样要查：只留监听不留发送的，是删代码时最容易漏下的那一半。
  check('主进程接的，preload 都发得出', diff(heard, sent))
}

console.log('2) 主进程 → 宠物页面')
{
  const sent = grab(petJs, /send\('([^']+)'/g)
  const heard = grab(petPreload, /ipcRenderer\.on\('([^']+)'/g)
  check('pet.js 发的，preload 都订阅了', diff(sent, heard))
  check('preload 订阅的，pet.js 都发得出', diff(heard, sent))
}

console.log('3) preload 暴露的接口，页面真的用得上')
{
  const exposed = grab(petPreload, /^ {2}(\w+):/gm)
  const used = grab(petHtml, /__dshPet\??\.(\w+)/g)
  check('暴露了却没人用', diff(exposed, used))
  check('页面用了却没暴露', diff(used, exposed))
}

console.log('4) 宠物窗不该拿到主窗的桥')
{
  // 宠物窗开着 sandbox，桥再窄越好。主窗那套 stream/unary 通道要是漏进来，
  // 等于给一个浮在所有窗口之上的小页面开了直连后端的口子。
  const petChannels = grab(petPreload, /ipcRenderer\.(?:send|invoke|on)\('([^']+)'/g)
  check('宠物 preload 只有 dsh:pet-* 通道', petChannels.filter((c) => !c.startsWith('dsh:pet-')))
}

console.log()
console.log(fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
