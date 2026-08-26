'use strict'

/**
 * 宠物的序列帧绘制器。
 *
 * 每条动画 4 帧、单帧 64×64、背景透明。加载哪一套由角色决定（见
 * `pet-characters.js`）—— 这里只认"目录 + 动画名"，不知道有几个角色。
 *
 * 放大用 `imageSmoothingEnabled = false`。这一句是像素风的命门：默认的双线性插值
 * 会把硬边糊成渐变，放大之后就不是像素画了。
 *
 * @module pet-sprite
 */

;(() => {

/** 单帧的边长。 */
const FRAME = 64

/** 每条动画的帧数。 */
const FRAMES = 4

/** 已解码的图片，按动画名存。换角色时整个换掉。 */
let images = new Map()

/** 当前这套素材是否已全部就绪；在此之前 draw 什么也不画，免得闪半张图。 */
let ready = false

/** 回落用的动画名 —— 每个角色都必须有 idle。 */
const FALLBACK = 'idle'

/**
 * 加载一个角色的全部素材。
 *
 * @param {{dir: string}} def 角色定义
 * @param {string[]} anims 要加载的动画名
 * @returns {Promise<string[]>} 加载失败的动画名；全好时是空数组
 */
function load(def, anims) {
  ready = false
  const next = new Map()
  const failed = []
  const one = (anim) => new Promise((resolve) => {
    const src = `${def.dir}/${anim}.png`
    const img = new Image()
    img.onload = () => { next.set(anim, img); resolve() }
    // 少一张就少一条动画，不该让整只宠物起不来。
    img.onerror = () => { console.error('[pet] 素材加载失败:', src); failed.push(anim); resolve() }
    img.src = src
  })
  return Promise.all(anims.map(one)).then(() => {
    images = next
    ready = true
    return failed
  })
}

/**
 * 画一帧。
 *
 * @param {CanvasRenderingContext2D} ctx 目标画布
 * @param {string} anim 动画名；缺素材时回落到 idle
 * @param {number} frame 帧序号，内部对帧数取模
 * @param {number} scale 整数放大倍数
 */
function draw(ctx, anim, frame, scale) {
  if (!ready) return
  const img = images.get(anim) ?? images.get(FALLBACK)
  if (img === undefined) return
  const size = FRAME * scale
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, size, size)
  const col = ((frame % FRAMES) + FRAMES) % FRAMES
  ctx.drawImage(img, col * FRAME, 0, FRAME, FRAME, 0, 0, size, size)
}

globalThis.__dshSprite = { FRAME, FRAMES, load, draw }
})()
