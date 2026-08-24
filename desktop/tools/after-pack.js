'use strict'

/**
 * 把运行时闭包放进打包结果的 resources/ 下。
 *
 * 为什么不用 electron-builder 的 `extraResources`：它对 node_modules 有一套自己的
 * 排除规则，`filter: ['**\/*']` 也没能让闭包完整进去 —— 实测拷进去的只有 lib/ 与
 * package.json，约 150K，而闭包本体 240M 全在 node_modules 里。更糟的是**这一步
 * 不报错**：安装包照常产出，直到运行时才报"找不到 @deepseek-ai/dsh-app-boot"。
 *
 * 自己复制就没有 glob 语义可争，并且能在这里把结果验一遍：拷完立刻检查关键路径，
 * 不对就让构建失败，而不是把问题推到用户的机器上。
 *
 * @module after-pack
 */

const fs = require('node:fs')
const path = require('node:path')

const RUNTIME = path.join(__dirname, '..', '..', 'runtime')

/**
 * @param {{ appOutDir: string }} context electron-builder 的打包上下文
 */
exports.default = async function afterPack(context) {
  if (!fs.existsSync(path.join(RUNTIME, 'package.json'))) {
    throw new Error(`找不到运行时闭包：${RUNTIME}\n请先在仓库根运行 \`npm run build:runtime\`。`)
  }

  const target = path.join(context.appOutDir, 'resources', 'runtime')
  fs.rmSync(target, { recursive: true, force: true })
  fs.cpSync(RUNTIME, target, { recursive: true, dereference: true })

  // 复制是否真的完整，只看这几处就够：顶层清单、CLI 产物、以及闭包主体所在的
  // node_modules。少了任何一处，应用都会在启动时才失败。
  for (const required of ['package.json', 'lib', 'node_modules/@deepseek-ai/dsh-app-boot']) {
    if (!fs.existsSync(path.join(target, required))) {
      throw new Error(`运行时闭包没有完整拷入安装包，缺少 ${required}`)
    }
  }
  const count = fs.readdirSync(path.join(target, 'node_modules', '@deepseek-ai')).length
  console.log(`  • 运行时闭包已放入 resources/runtime（@deepseek-ai 包 ${count} 个）`)
}
