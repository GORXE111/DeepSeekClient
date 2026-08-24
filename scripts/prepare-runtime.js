'use strict'

/**
 * 把 webServer 替身放进运行时闭包。
 *
 * 替身要被 Cordis 的 loader 按包名解析（`@dsh-desktop/webserver-ipc`），所以它
 * 必须躺在闭包的 node_modules 里，和其他插件包平级 —— 而不是留在壳的源码目录，
 * 那里对 loader 不可见。
 *
 * 用复制而不是符号链接：链接在 electron-builder 打包与跨平台解压时行为不一致，
 * 而这份代码只有百来行，复制的代价可以忽略。
 *
 * npm 的扁平布局在这里是优势：替身放进 runtime/node_modules 之后，它 import 的
 * `@deepseek-ai/cordis` 会从同一层解析到 —— 换成 pnpm 的隔离布局就要另做安排。
 */

const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const source = path.join(root, 'packages', 'webserver-ipc')
const targetDir = path.join(root, 'runtime', 'node_modules', '@dsh-desktop')
const target = path.join(targetDir, 'webserver-ipc')

if (!fs.existsSync(path.join(root, 'runtime', 'node_modules'))) {
  console.error('runtime/node_modules 不存在 —— 先在 runtime/ 下执行 npm install。')
  process.exit(1)
}
if (!fs.existsSync(source)) {
  console.error(`找不到替身包：${source}`)
  process.exit(1)
}

fs.rmSync(target, { recursive: true, force: true })
fs.mkdirSync(targetDir, { recursive: true })
// 只带包本身，不带它开发期链进来的 node_modules。
fs.cpSync(source, target, {
  recursive: true,
  filter: (src) => !src.split(path.sep).includes('node_modules'),
})

const cordis = path.join(root, 'runtime', 'node_modules', '@deepseek-ai', 'cordis')
if (!fs.existsSync(cordis)) {
  console.error('警告：闭包里没有 @deepseek-ai/cordis，替身将无法加载。')
  process.exit(1)
}

console.log(`替身已就位：${path.relative(root, target)}`)
