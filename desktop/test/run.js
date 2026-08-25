'use strict'

/**
 * 跑一遍 desktop/ 下的所有测试。
 *
 * 每个用例文件各自是一个独立进程：它们都用假定时器替换全局的时间概念，同进程
 * 里跑会互相污染。进程隔离比在文件之间约定"谁负责恢复现场"可靠得多。
 */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const dir = __dirname
const files = fs.readdirSync(dir).filter((f) => /\.test\.(js|mjs)$/.test(f)).sort()

let failed = 0
for (const f of files) {
  console.log('── ' + f + ' ' + '─'.repeat(Math.max(0, 60 - f.length)))
  try {
    execFileSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' })
  } catch {
    failed++
  }
  console.log()
}

if (failed > 0) {
  console.error(`${failed}/${files.length} 个用例文件失败`)
  process.exit(1)
}
console.log(`${files.length} 个用例文件全部通过`)
