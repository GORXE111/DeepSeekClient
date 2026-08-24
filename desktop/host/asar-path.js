'use strict'

/**
 * asar 路径改写。
 *
 * 打包之后，`require.resolve` 与 `__dirname` 给出的路径都指向 `app.asar` 内部。
 * 对 Electron 自己的 fs 读操作这是透明的，但有两类事情**穿不过归档**：
 *
 *  · 符号链接。app-boot 会按运行时根目录为 profile 建一棵扁平的 node_modules，
 *    每个插件一条链接。链接由操作系统解析，asar 里的路径在文件系统上并不存在
 *    —— 于是每个插件都"找不到包"，而错误信息只会说包不存在，不会提 asar。
 *  · `cpSync` 的递归复制。
 *
 * 两者都要求真实路径。electron-builder 已用 asarUnpack 把这些内容留在
 * `app.asar.unpacked` 下，这里只是把路径指过去。开发期路径里没有 app.asar，
 * 原样返回。
 *
 * @module asar-path
 */

const path = require('node:path')

const INSIDE = `${path.sep}app.asar${path.sep}`
const OUTSIDE = `${path.sep}app.asar.unpacked${path.sep}`

/**
 * 把 asar 内的路径换成解包后的真实路径。
 *
 * @param {string} p 任意路径
 * @returns {string} 解包后的路径；不在 asar 内则原样返回
 */
function unpackedPath(p) {
  return p.includes(INSIDE) ? p.replace(INSIDE, OUTSIDE) : p
}

module.exports = { unpackedPath }
