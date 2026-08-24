'use strict'

/**
 * 从 harness 源码产出运行时闭包。
 *
 * 闭包是安装包里真正被执行的那份 harness：一棵**扁平且没有符号链接**的
 * node_modules，外加 CLI 包自身的 `lib/` 与 `package.json`。两个约束都不是偏好：
 *
 *  · 扁平 —— Cordis 的 loader 按真实文件路径解析插件，app-boot 还会据此为
 *    profile 建链接树。pnpm 默认那套 `.pnpm` 隔离布局在原地能跑，但链接是**绝对
 *    路径**，闭包一旦被拷进安装包就全断了。`node-linker=hoisted` 产出的才是可
 *    搬运的。
 *  · 只含生产依赖 —— 开发依赖（构建工具、测试框架）没有理由进安装包。
 *
 * `--legacy` 是 pnpm 10 起的要求：不走 injected 依赖时必须显式声明。
 *
 * 用法：npm run build:runtime
 *
 * @module build-runtime
 */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const HARNESS = path.join(ROOT, 'harness')
const RUNTIME = path.join(ROOT, 'runtime')

if (!fs.existsSync(path.join(HARNESS, 'pnpm-workspace.yaml'))) {
  console.error(`找不到 harness 源码：${HARNESS}`)
  process.exit(1)
}

// pnpm 会拒绝写入非空目录，而这里本就该是每次重建的产物。
fs.rmSync(RUNTIME, { recursive: true, force: true })

console.log('产出运行时闭包（这一步比较慢）…')
execFileSync('npx', [
  'pnpm', 'deploy',
  '--legacy',
  '--prod',
  '--config.node-linker=hoisted',
  '--filter', '@deepseek-ai/dsh',
  RUNTIME,
], { cwd: HARNESS, stdio: 'inherit', shell: true })

// `--prod` 会把工作区自身的安装状态也标成"仅生产依赖"，于是之后在 harness 里跑
// 测试或类型检查时，pnpm 会想清空 node_modules 重装，并在没有 TTY 的环境下直接
// 中止 —— 报错完全看不出跟打包有关。在这里立刻恢复，代价只有几秒。
console.log('恢复 harness 工作区的开发依赖…')
execFileSync('npx', ['pnpm', 'install'], {
  cwd: HARNESS,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, CI: 'true' },
})

// 闭包必须自洽：漏了这两样，失败会推迟到应用启动时才暴露，且报错指向别处。
for (const required of ['package.json', 'lib', 'node_modules/@deepseek-ai/dsh-web-app']) {
  if (!fs.existsSync(path.join(RUNTIME, required))) {
    console.error(`闭包不完整，缺少 ${required}`)
    process.exit(1)
  }
}

/**
 * 补齐 deploy 漏掉的工作区包。
 *
 * `vendor/*` 里的包在锁文件里记成 `link:`（工作区内是软链，见 pnpm-workspace.yaml
 * 的 linkWorkspacePackages），而 `pnpm deploy` 对这类依赖的搬运并不可靠 —— 实测
 * 会静默漏掉一部分，症状是应用启动时报"找不到包"，且每次只暴露一个，修一个冒
 * 一个。
 *
 * 与其逐个追，不如在这里把不变量守住：遍历闭包里每个包声明的生产依赖，凡是不
 * 存在的就从工作区复制进来，直到不动点。缺什么会打印出来，所以这既是补救也是
 * 体检 —— 上游哪天改了依赖结构，这里会说话。
 */
function completeClosure() {
  // 工作区包索引：包名 → 目录。
  const index = new Map()
  for (const group of ['vendor', 'packages', 'apps']) {
    const base = path.join(HARNESS, group)
    if (!fs.existsSync(base)) continue
    const walk = (dir, depth) => {
      if (depth > 2) return
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'node_modules') continue
        const child = path.join(dir, entry.name)
        const manifest = path.join(child, 'package.json')
        if (fs.existsSync(manifest)) {
          try { index.set(JSON.parse(fs.readFileSync(manifest, 'utf8')).name, child) } catch { /* 跳过坏清单 */ }
        }
        walk(child, depth + 1)
      }
    }
    walk(base, 0)
  }

  const modules = path.join(RUNTIME, 'node_modules')

  /**
   * 从一个 specifier 取包名，且**只认我们自己作用域下的包**。
   *
   * 源码扫描用的是正则，模板字符串、日志文本里的引号都会被扫进来。放宽到任意
   * 包名就会把这些噪音当成缺失依赖；限定在 `@deepseek-ai/<name>` 这个形状上，
   * 既覆盖了要解决的那一类问题（工作区包没进闭包），又不会误报 —— 第三方依赖
   * 由 deploy 正常解析，本就不归这里管。
   */
  const packageOf = (spec) => {
    const match = /^(@deepseek-ai\/[a-z0-9][a-z0-9._-]*)(?:\/|$)/.exec(spec)
    return match === null ? undefined : match[1]
  }

  // 声明依赖之外还要扫真实 import：上游存在"import 了但没写进 dependencies"的
  // 包（实测 dsh-llm → dsh-timeout）。只看清单会漏掉它们，而漏掉的代价是应用
  // 启动时才报错。
  const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g

  const scanSources = (dir, into, depth = 0) => {
    if (depth > 4 || !fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const child = path.join(dir, entry.name)
      if (entry.isDirectory()) { scanSources(child, into, depth + 1); continue }
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue
      let text
      try { text = fs.readFileSync(child, 'utf8') } catch { continue }
      for (const match of text.matchAll(SPECIFIER)) {
        const name = packageOf(match[1])
        if (name !== undefined) into.add(name)
      }
    }
  }

  const added = []
  for (let round = 0; round < 10; round++) {
    const required = new Set()
    const fromManifest = (manifestPath) => {
      let deps
      try { deps = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).dependencies } catch { return }
      for (const name of Object.keys(deps ?? {})) required.add(name)
    }
    fromManifest(path.join(RUNTIME, 'package.json'))
    scanSources(path.join(RUNTIME, 'lib'), required)

    const visit = (pkgDir) => {
      fromManifest(path.join(pkgDir, 'package.json'))
      // 只扫我们自己工作区的包：第三方依赖由 deploy 正常解析，扫它们既慢又会
      // 把可选依赖误报成缺失。
      scanSources(path.join(pkgDir, 'lib'), required)
    }
    for (const scope of fs.readdirSync(modules, { withFileTypes: true })) {
      if (!scope.isDirectory() || scope.name.startsWith('.')) continue
      if (scope.name === '@deepseek-ai') {
        for (const pkg of fs.readdirSync(path.join(modules, scope.name), { withFileTypes: true })) {
          if (pkg.isDirectory()) visit(path.join(modules, scope.name, pkg.name))
        }
      } else if (scope.name.startsWith('@')) {
        for (const pkg of fs.readdirSync(path.join(modules, scope.name), { withFileTypes: true })) {
          if (pkg.isDirectory()) fromManifest(path.join(modules, scope.name, pkg.name, 'package.json'))
        }
      } else {
        fromManifest(path.join(modules, scope.name, 'package.json'))
      }
    }

    const missing = [...required].filter(name => !fs.existsSync(path.join(modules, name)))
    const fixable = missing.filter(name => index.has(name))
    // 工作区之外的缺失只警告不中断。这些多半是客户端包的构建期依赖（shiki、
    // katex、micromark 之流）—— 它们在构建时就被打进浏览器 bundle，Node 侧运行时
    // 并不 require，deploy 因此没有装。真要是运行时需要，应用启动会立刻报出来，
    // 而在这里一刀切失败只会挡住正常构建。
    const unfixable = missing.filter(name => !index.has(name))
    if (round === 0 && unfixable.length > 0) {
      console.warn(`注意：闭包里没有这些第三方包（多为构建期依赖，运行时通常用不到）：${unfixable.join(', ')}`)
    }
    if (fixable.length === 0) break

    for (const name of fixable) {
      const target = path.join(modules, name)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.cpSync(index.get(name), target, {
        recursive: true,
        dereference: true,
        filter: src => !src.split(path.sep).includes('node_modules'),
      })
      added.push(name)
    }
  }
  return added
}

const patched = completeClosure()
if (patched.length > 0) {
  console.log(`deploy 漏掉、已从工作区补入 ${patched.length} 个包：${patched.join(', ')}`)
}

// 有符号链接就说明 hoisted 没生效，而症状要到装机之后才出现 —— 在这里拦住。
const links = []
const scan = (dir, depth) => {
  if (depth > 3) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) links.push(path.join(dir, entry.name))
    else if (entry.isDirectory()) scan(path.join(dir, entry.name), depth + 1)
  }
}
scan(path.join(RUNTIME, 'node_modules'), 0)
if (links.length > 0) {
  console.error(`闭包里有 ${links.length} 条符号链接，搬运后会断，例如：${links[0]}`)
  process.exit(1)
}

console.log(`\n运行时闭包就绪：${RUNTIME}`)
