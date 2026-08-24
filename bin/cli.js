#!/usr/bin/env node
'use strict'

/**
 * `deepseek-client` 命令入口。
 *
 * 用户装完这个包之后敲一个命令就该看到窗口 —— 不需要知道 Electron、不需要
 * 配 profile、不需要起服务。所以这里只做一件事：找到 Electron 可执行文件，
 * 把主进程交给它。
 *
 * 为什么不直接 `require('electron')` 然后跑：那个包在 Node 里 require 时导出的
 * 是可执行文件的路径字符串，不是 Electron API —— 必须 spawn 它，主进程代码才
 * 会在 Electron 运行时里执行。
 */

const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const root = path.join(__dirname, '..')

/** Electron 可执行文件。缺失通常意味着安装期二进制没下下来。 */
function resolveElectron() {
  let binary
  try {
    binary = require('electron')
  } catch {
    binary = undefined
  }
  if (typeof binary !== 'string' || !fs.existsSync(binary)) {
    console.error([
      '找不到 Electron 可执行文件。',
      '',
      '通常是安装时二进制没有下载成功。国内网络下建议先设镜像再重装：',
      '  npm config set ELECTRON_MIRROR https://npmmirror.com/mirrors/electron/',
      '  npm install -g deepseek-client',
    ].join('\n'))
    process.exit(1)
  }
  return binary
}

const child = spawn(resolveElectron(), [root, ...process.argv.slice(2)], {
  stdio: 'inherit',
  // Windows 上 Electron 会自己开窗口，控制台留给日志。
  windowsHide: false,
})

child.on('exit', (code, signal) => {
  // 转达真实退出码，让 CI 与 shell 判断得准。
  process.exit(signal !== null ? 1 : (code ?? 0))
})
child.on('error', (err) => {
  console.error('启动失败：', err.message)
  process.exit(1)
})
