'use strict'

/**
 * 聊天背景壁纸的本地库。
 *
 * 图片**存盘，不进设置**。设置文档里只留一个 id。把图片本身塞进设置是最省事的
 * 做法，但那份文档会被反复整份读写 —— 我们自己的报喜逻辑每攒一批就要
 * `settings.describe` 一次，那时候顺带把几百 KB 的 base64 一起搬运，纯属浪费。
 * 何况 YAML 里躺着一大块 base64，出了问题也没法用眼睛看。
 *
 * id 用内容哈希：同一张图重复添加得到同一个 id，不会在库里堆出一排一模一样的
 * 缩略图；而且 URL 天然带版本，换了图就是换了 id，不用操心缓存。
 *
 * 每张图存两份：原图铺背景，缩略图进设置面板的小方块。少了缩略图，六个小方块
 * 就要解码六张 1600px 的大图，为了一个 44 像素见方的格子。
 *
 * @module wallpapers
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

/** 库里最多留几张。再多就不是"切换背景"而是"管理相册"了。 */
const MAX_COUNT = 12

/** 单张图的字节上限。页面上传前已经缩过，超过这个数说明那边出了岔子。 */
const MAX_BYTES = 8 * 1024 * 1024

/** id 的形状。用它挡路径穿越 —— 这个 id 会直接拼进文件名。 */
const ID = /^[0-9a-f]{16}$/

/** 原图与缩略图的后缀。页面统一转成 JPEG 再传，所以只有这一种类型。 */
const EXT = { full: '.jpg', thumb: '.t.jpg' }

/**
 * 建一个壁纸库。
 *
 * @param {object} deps
 * @param {string} deps.dir 存放目录，不存在会建
 * @param {number} [deps.maxCount] 数量上限，测试时可注入
 * @param {number} [deps.maxBytes] 单张字节上限
 */
function createWallpaperStore({ dir, maxCount = MAX_COUNT, maxBytes = MAX_BYTES }) {
  const file = (id, variant) => path.join(dir, id + EXT[variant])

  const ensureDir = () => { fs.mkdirSync(dir, { recursive: true }) }

  /**
   * 库里现有的壁纸，新的在前。
   * @returns {string[]} id 列表
   */
  const list = () => {
    let names
    try { names = fs.readdirSync(dir) } catch { return [] }
    const ids = []
    for (const name of names) {
      // 只认原图，缩略图不单独成条 —— 它俩共用一个 id。
      if (!name.endsWith(EXT.full) || name.endsWith(EXT.thumb)) continue
      const id = name.slice(0, -EXT.full.length)
      if (!ID.test(id)) continue
      let mtime = 0
      try { mtime = fs.statSync(path.join(dir, name)).mtimeMs } catch { continue }
      ids.push({ id, mtime })
    }
    ids.sort((a, b) => b.mtime - a.mtime)
    return ids.map((entry) => entry.id)
  }

  /**
   * 收一张图。
   *
   * 超过数量上限就把最旧的挤掉，而不是报错让用户先去删 —— 这是个装饰功能，不该
   * 为了它弹一个"请先清理"的对话框。
   *
   * @param {Buffer} full 原图字节
   * @param {Buffer} thumb 缩略图字节
   * @returns {{ok: true, id: string} | {ok: false, error: string}}
   */
  const add = (full, thumb) => {
    if (!Buffer.isBuffer(full) || !Buffer.isBuffer(thumb)) return { ok: false, error: '缺少图片数据' }
    if (full.length === 0 || thumb.length === 0) return { ok: false, error: '图片是空的' }
    if (full.length > maxBytes) return { ok: false, error: `图片太大（上限 ${Math.round(maxBytes / 1024 / 1024)}MB）` }
    // JPEG 的魔数。页面那边统一转过码，对不上说明传来的不是我们以为的东西。
    if (full[0] !== 0xff || full[1] !== 0xd8) return { ok: false, error: '不是 JPEG 数据' }

    const id = crypto.createHash('sha256').update(full).digest('hex').slice(0, 16)
    try {
      ensureDir()
      fs.writeFileSync(file(id, 'full'), full)
      fs.writeFileSync(file(id, 'thumb'), thumb)
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) }
    }

    // 挤掉最旧的。list() 已经按新旧排好，从尾巴上砍。
    const ids = list()
    for (const stale of ids.slice(maxCount)) remove(stale)
    return { ok: true, id }
  }

  /**
   * 删一张。
   * @param {string} id
   * @returns {boolean} 是否删掉了什么
   */
  const remove = (id) => {
    if (!ID.test(id)) return false
    let gone = false
    for (const variant of ['full', 'thumb']) {
      try { fs.unlinkSync(file(id, variant)); gone = true } catch { /* 本来就没有 */ }
    }
    return gone
  }

  /**
   * 读一张的字节。
   * @param {string} id
   * @param {'full'|'thumb'} variant
   * @returns {Buffer | null} 没有就是 null
   */
  const read = (id, variant) => {
    // id 直接拼进文件名，形状不对一律拒绝 —— 这是挡路径穿越的那道门。
    if (!ID.test(id)) return null
    if (variant !== 'full' && variant !== 'thumb') return null
    try { return fs.readFileSync(file(id, variant)) } catch { return null }
  }

  return { list, add, remove, read, maxCount }
}

/**
 * 从 data URI 里取出字节。
 *
 * 只认 JPEG 的 base64 形式：页面上传前统一转过码，别的形式到不了这里，而放宽
 * 判断等于给自己开一个"什么都能塞进来"的口子。
 *
 * @param {unknown} uri 形如 `data:image/jpeg;base64,...`
 * @returns {Buffer | null} 解不出来就是 null
 */
function decodeDataUri(uri) {
  if (typeof uri !== 'string') return null
  const prefix = 'data:image/jpeg;base64,'
  if (!uri.startsWith(prefix)) return null
  try {
    const buf = Buffer.from(uri.slice(prefix.length), 'base64')
    return buf.length === 0 ? null : buf
  } catch { return null }
}

/** 这条路由挂在哪个前缀下。两个下划线是为了和上游的路径分开。 */
const ROUTE = '/__wallpaper'

/**
 * 建一个处理 `/__wallpaper` 的请求处理器。
 *
 * 做成普通的 Request→Response 函数而不是直接写在协议处理器里，是为了能测：这里有
 * 方法分发、状态码、和一条**只在浏览器里才走得到**的路径（设置面板发的 fetch）。
 * 留在 main.js 里就只能靠人点一遍界面来验，而且点不出 405 和 404 这些分支。
 *
 * @param {ReturnType<createWallpaperStore>} store 壁纸库
 * @returns {(request: Request, url: URL) => Promise<Response>}
 */
function createWallpaperRoutes(store) {
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
  })

  return async (request, url) => {
    const rest = url.pathname.slice(ROUTE.length).replace(/^\//, '')

    // /__wallpaper —— 列出与新增
    if (rest === '') {
      if (request.method === 'GET') return json({ items: store.list(), max: store.maxCount })
      if (request.method === 'POST') {
        let payload
        try { payload = JSON.parse(await request.text()) } catch { return json({ error: '请求不是 JSON' }, 400) }
        const full = decodeDataUri(payload?.full)
        const thumb = decodeDataUri(payload?.thumb)
        if (full === null || thumb === null) return json({ error: '图片数据不合法' }, 400)
        const added = store.add(full, thumb)
        return added.ok ? json({ id: added.id }) : json({ error: added.error }, 400)
      }
      return json({ error: '不支持的方法' }, 405)
    }

    // /__wallpaper/<id> 与 /__wallpaper/<id>/thumb
    const [id, variant = 'full'] = rest.split('/')
    if (request.method === 'DELETE') {
      return store.remove(id) ? json({ ok: true }) : json({ error: '没有这张' }, 404)
    }
    if (request.method !== 'GET') return json({ error: '不支持的方法' }, 405)
    const bytes = store.read(id, variant === 'thumb' ? 'thumb' : 'full')
    if (bytes === null) return json({ error: '没有这张' }, 404)
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        // id 是内容哈希，同一个 URL 的字节永远不变，可以放心长缓存。
        'cache-control': 'public, max-age=31536000, immutable',
      },
    })
  }
}

module.exports = { createWallpaperStore, createWallpaperRoutes, decodeDataUri, ROUTE, MAX_COUNT, MAX_BYTES, ID }
