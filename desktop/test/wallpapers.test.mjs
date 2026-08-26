/**
 * 壁纸槽位的测试。
 *
 * 两处非做不可：**id 直接拼进文件名**（那是挡路径穿越的唯一一道门），以及**换图会
 * 删文件**（写错方向就是把用户刚选的那张删掉，留下旧的）。两者在界面上都看不出来
 * —— 前者出事时静悄悄，后者出事时你以为是自己点错了。
 *
 * 用法：node desktop/test/wallpapers.test.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// 顶层 await 需要 ESM；被测模块是 CommonJS，用 createRequire 拉进来。
const require = createRequire(import.meta.url)
const { createWallpaperStore, createWallpaperRoutes, decodeDataUri, ROUTE } = require('../host/wallpapers.js')

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra === '' ? '' : '  → ' + extra)) }
}

/** 一段以 JPEG 魔数开头的假图。内容不同 → 哈希不同 → id 不同。 */
const jpeg = (seed) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(String(seed).repeat(8))])

/** 每组测试用一个干净的临时目录。 */
function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wall-'))
  return { dir, store: createWallpaperStore({ dir, ...opts }) }
}

console.log('1) 加一张、读回来、列出来')
{
  const { store, dir } = setup()
  check('空库列出空数组', store.list().length === 0)

  const added = store.add(jpeg('a'), jpeg('a-thumb'))
  check('加成功', added.ok === true, JSON.stringify(added))
  check('id 是 16 位十六进制', /^[0-9a-f]{16}$/.test(added.id), added.id)
  check('列出来了', store.list().join() === added.id, store.list().join())
  check('读原图', Buffer.compare(store.read(added.id, 'full'), jpeg('a')) === 0)
  check('读缩略图', Buffer.compare(store.read(added.id, 'thumb'), jpeg('a-thumb')) === 0)
  check('原图和缩略图是两个文件', fs.readdirSync(dir).length === 2, fs.readdirSync(dir).join())
}

console.log('2) id 是内容哈希')
{
  const { store } = setup()
  const first = store.add(jpeg('same'), jpeg('t'))
  const again = store.add(jpeg('same'), jpeg('t'))
  // 同一张图重选一次不该换地址：URL 变了浏览器就要重新下载同样的字节。
  check('两次得到同一个 id', first.id === again.id, `${first.id} vs ${again.id}`)
  check('槽位里还是一张', store.list().length === 1, String(store.list().length))

  const other = store.add(jpeg('different'), jpeg('t'))
  // 反过来，换了图就必须换地址，否则浏览器会拿着缓存里的旧图不放。
  check('不同内容不同 id', other.id !== first.id)
  check('槽位里仍然只有一张', store.list().length === 1, String(store.list().length))
}

console.log('3) 挡住不该收的东西')
{
  const { store } = setup()
  const rejects = (label, ...args) => {
    const r = store.add(...args)
    check(label, r.ok === false, JSON.stringify(r))
  }
  rejects('不是 Buffer', 'not a buffer', jpeg('t'))
  rejects('缺缩略图', jpeg('a'), undefined)
  rejects('空 Buffer', Buffer.alloc(0), jpeg('t'))
  // 页面那边统一转过码，魔数对不上说明传来的不是我们以为的东西。
  rejects('不是 JPEG（PNG 魔数）', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), jpeg('t'))
  rejects('伪装成图片的文本', Buffer.from('<html>hi</html>'), jpeg('t'))
  check('一个都没进库', store.list().length === 0, String(store.list().length))

  const small = createWallpaperStore({ dir: setup().dir, maxBytes: 32 })
  const big = small.add(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(64)]), jpeg('t'))
  check('超过字节上限', big.ok === false && big.error.includes('太大'), JSON.stringify(big))
}

console.log('4) id 直接拼文件名，形状不对一律拒绝')
{
  // 这是挡路径穿越的那道门。放宽一点就意味着 read() 能读到库外的任何文件。
  const { store, dir } = setup()
  store.add(jpeg('a'), jpeg('t'))
  // 在库外放一个"想被读到"的文件。
  const outside = path.join(dir, '..', 'dsh-wall-secret.jpg')
  fs.writeFileSync(outside, 'TOP SECRET')

  const evil = [
    '../dsh-wall-secret',
    '..\\dsh-wall-secret',
    '../../etc/passwd',
    'a/../../x',
    'AAAAAAAAAAAAAAAA',      // 十六进制之外的字符
    '0123456789abcde',       // 15 位，短一位
    '0123456789abcdef0',     // 17 位，长一位
    '',
    '0123456789ABCDEF',      // 大写
  ]
  let leaked = 0
  for (const id of evil) if (store.read(id, 'full') !== null) leaked++
  check('没有一个读得出东西', leaked === 0, String(leaked))

  let removed = 0
  for (const id of evil) if (store.remove(id)) removed++
  check('也一个都删不掉', removed === 0, String(removed))
  check('库外的文件还在', fs.existsSync(outside))

  check('认不得的 variant 读不出来', store.read(store.list()[0], '../../x') === null)
  fs.unlinkSync(outside)
}

console.log('5) 只有一个槽位：换一张就替掉上一张')
{
  const { store, dir } = setup()          // 不注入 maxCount，用产品里的真实值
  const first = store.add(jpeg('one'), jpeg('t1'))
  check('先有一张', store.list().join() === first.id)
  const until = Date.now() + 12
  while (Date.now() < until) { /* 让 mtime 分得开 */ }
  const second = store.add(jpeg('two'), jpeg('t2'))
  check('换完还是一张', store.list().length === 1, String(store.list().length))
  check('留下的是新的', store.list()[0] === second.id, store.list().join())
  check('旧的读不出来了', store.read(first.id, 'full') === null)
  check('旧的缩略图也清了', store.read(first.id, 'thumb') === null)
  check('盘上只剩两个文件', fs.readdirSync(dir).length === 2, fs.readdirSync(dir).join())
}

console.log('5b) 挤旧这件事本身在多于一张时也对')
{
  const { store } = setup({ maxCount: 3 })
  const ids = []
  for (let i = 0; i < 5; i++) {
    const r = store.add(jpeg('img' + i), jpeg('t' + i))
    ids.push(r.id)
    // mtime 的分辨率有限，隔开一点才排得出先后。
    const until = Date.now() + 12
    while (Date.now() < until) { /* 等一小会儿 */ }
  }
  const left = store.list()
  check('只留 3 张', left.length === 3, String(left.length))
  check('留下的是最新的 3 张', left.join() === [ids[4], ids[3], ids[2]].join(), left.join())
  check('最旧的读不出来了', store.read(ids[0], 'full') === null)
  check('被挤掉的缩略图也清了', store.read(ids[0], 'thumb') === null)
}

console.log('6) 移除')
{
  const { store, dir } = setup()
  const only = store.add(jpeg('a'), jpeg('ta'))
  check('删掉了', store.remove(only.id) === true)
  check('槽位空了', store.list().length === 0, store.list().join())
  check('原图和缩略图都清了', fs.readdirSync(dir).length === 0, fs.readdirSync(dir).join())
  check('重复删返回 false', store.remove(only.id) === false)
}

console.log('7) 目录不存在也不炸')
{
  const dir = path.join(os.tmpdir(), 'dsh-wall-nope-' + process.pid)
  const store = createWallpaperStore({ dir })
  check('列出空数组', store.list().length === 0)
  check('读返回 null', store.read('0123456789abcdef', 'full') === null)
  const added = store.add(jpeg('a'), jpeg('t'))
  check('加的时候把目录建出来', added.ok === true, JSON.stringify(added))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('8) data URI 解码')
{
  const uri = (b64) => 'data:image/jpeg;base64,' + b64
  const bytes = Buffer.from([0xff, 0xd8, 0x01, 0x02])
  check('正常解出来', Buffer.compare(decodeDataUri(uri(bytes.toString('base64'))), bytes) === 0)
  // 只认 JPEG 的这一种形式：页面统一转过码，放宽判断等于给自己开一个口子。
  check('PNG 的 data URI 不认', decodeDataUri('data:image/png;base64,iVBOR') === null)
  check('svg 不认', decodeDataUri('data:image/svg+xml;base64,PHN2Zz4=') === null)
  check('裸字符串不认', decodeDataUri('ZmZk') === null)
  check('空 base64 不认', decodeDataUri(uri('')) === null)
  check('不是字符串不认', decodeDataUri(Buffer.from('x')) === null)
  check('undefined 不认', decodeDataUri(undefined) === null)
}

/* ── 路由 ───────────────────────────────────────────────────────────────
   页面就是靠这几条 fetch 跟壳打交道的。405/404 这些分支手点界面点不出来。 */

const req = (method, p, body) => [
  new Request('http://x' + p, {
    method,
    ...body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
  }),
  new URL('http://x' + p),
]

async function routeTests() {
  console.log('9) 路由')
  const { store } = setup()
  const handle = createWallpaperRoutes(store)
  const uri = (b) => 'data:image/jpeg;base64,' + b.toString('base64')

  let r = await handle(...req('GET', ROUTE))
  check('空库 GET 列表', r.status === 200)
  let body = await r.json()
  check('返回 items 和上限', Array.isArray(body.items) && body.items.length === 0 && body.max > 0, JSON.stringify(body))

  r = await handle(...req('POST', ROUTE, { full: uri(jpeg('a')), thumb: uri(jpeg('t')) }))
  check('POST 加一张', r.status === 200)
  const { id } = await r.json()
  check('返回了 id', /^[0-9a-f]{16}$/.test(id), String(id))

  r = await handle(...req('GET', ROUTE))
  body = await r.json()
  check('列表里有它', body.items.join() === id, body.items.join())

  r = await handle(...req('GET', `${ROUTE}/${id}`))
  check('取原图 200', r.status === 200)
  check('是 JPEG', r.headers.get('content-type') === 'image/jpeg', String(r.headers.get('content-type')))
  // id 是内容哈希，同一个 URL 的字节永远不变。
  check('可以长缓存', String(r.headers.get('cache-control')).includes('immutable'), String(r.headers.get('cache-control')))
  check('字节对得上', Buffer.compare(Buffer.from(await r.arrayBuffer()), jpeg('a')) === 0)

  r = await handle(...req('GET', `${ROUTE}/${id}/thumb`))
  check('取缩略图', Buffer.compare(Buffer.from(await r.arrayBuffer()), jpeg('t')) === 0)

  r = await handle(...req('GET', `${ROUTE}/${id}/天知道`))
  check('认不得的 variant 当原图处理', r.status === 200)

  r = await handle(...req('GET', `${ROUTE}/0000000000000000`))
  check('没有的那张 404', r.status === 404, String(r.status))

  r = await handle(...req('GET', `${ROUTE}/..%2F..%2Fsecret`))
  check('路径穿越 404 而不是读到东西', r.status === 404, String(r.status))

  r = await handle(...req('POST', ROUTE, { full: 'nope', thumb: 'nope' }))
  check('数据不合法 400', r.status === 400, String(r.status))

  r = await handle(...req('POST', ROUTE, { full: uri(Buffer.from('<html>')), thumb: uri(jpeg('t')) }))
  check('不是 JPEG 400', r.status === 400, String(r.status))

  const bad = new Request('http://x' + ROUTE, { method: 'POST', body: '{ 坏 json' })
  r = await handle(bad, new URL('http://x' + ROUTE))
  check('坏 JSON 400', r.status === 400, String(r.status))

  r = await handle(...req('PUT', ROUTE))
  check('不支持的方法 405', r.status === 405, String(r.status))
  r = await handle(...req('PUT', `${ROUTE}/${id}`))
  check('单张上不支持的方法 405', r.status === 405, String(r.status))

  r = await handle(...req('DELETE', `${ROUTE}/${id}`))
  check('DELETE 删掉', r.status === 200)
  check('删完就没了', store.list().length === 0, String(store.list().length))
  r = await handle(...req('DELETE', `${ROUTE}/${id}`))
  check('重复 DELETE 404', r.status === 404, String(r.status))
}

await routeTests()

console.log()
console.log(fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过, ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
