'use strict'

/**
 * 宠物的序列帧绘制器。
 *
 * 八条动画，每条 4 帧、单帧 64×64、背景已透明。分两类用：
 *
 *  · **底色**（会一直循环）：idle、thinking、wave、sleepy、shy
 *  · **一次性**（放完一轮就回到底色）：happy、clap、sad
 *
 * 谁属于哪一类由调用方决定，这里只管画 —— 同一条 wave 既能当"一直招手等你处理"
 * 的底色，也能当"打个招呼"的一次性动画。
 *
 * 放大用 `imageSmoothingEnabled = false`。这一句是像素风的命门：默认的双线性插值
 * 会把硬边糊成渐变，放大之后就不是像素画了。
 *
 * @module pet-sprite
 */

;(() => {

/** 单帧的边长。素材是 4×4 的 256×256 表，切成八条 256×64 的横条。 */
const FRAME = 64

/** 每条动画的帧数。 */
const FRAMES = 4

/** 动画名到素材的映射。名字就是对外的动画名，多一层转换只会多一个出错的地方。 */
const SHEETS = {
  idle: 'assets/miku-idle.png',
  thinking: 'assets/miku-thinking.png',
  happy: 'assets/miku-happy.png',
  sad: 'assets/miku-sad.png',
  wave: 'assets/miku-wave.png',
  clap: 'assets/miku-clap.png',
  shy: 'assets/miku-shy.png',
  sleepy: 'assets/miku-sleepy.png',
}

/** 已解码的图片，按动画名存。 */
const images = new Map()

/** 全部素材就绪后置为 true；在此之前 draw 什么也不画，免得闪半张图。 */
let ready = false

/**
 * 预加载八条精灵图。
 * @returns {Promise<void>} 全部就绪后兑现；单张失败不阻塞其余，那条动画回落到 idle。
 */
function load() {
  const one = (anim, src) => new Promise((resolve) => {
    const img = new Image()
    img.onload = () => { images.set(anim, img); resolve() }
    // 少一张就少一条动画，不该让整只宠物起不来。
    img.onerror = () => { console.error('[pet] 素材加载失败:', src); resolve() }
    img.src = src
  })
  return Promise.all(Object.entries(SHEETS).map(([anim, src]) => one(anim, src)))
    .then(() => { ready = true })
}

/**
 * 画一帧。
 *
 * @param {CanvasRenderingContext2D} ctx 目标画布
 * @param {string} anim 动画名；未知或缺素材时回落到 idle
 * @param {number} frame 帧序号，内部对帧数取模
 * @param {number} scale 整数放大倍数
 */
function draw(ctx, anim, frame, scale) {
  if (!ready) return
  const img = images.get(anim) ?? images.get('idle')
  if (img === undefined) return
  const size = FRAME * scale
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, size, size)
  const col = ((frame % FRAMES) + FRAMES) % FRAMES
  ctx.drawImage(img, col * FRAME, 0, FRAME, FRAME, 0, 0, size, size)
}

globalThis.__dshSprite = { FRAME, FRAMES, ANIMS: Object.keys(SHEETS), load, draw }
})()
