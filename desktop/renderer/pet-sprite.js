'use strict'

/**
 * 宠物的序列帧绘制器。
 *
 * 素材是三条横向精灵图（每条 4 帧、单帧 64×64、背景已透明），按状态切换：待机、
 * 招呼、忙碌。早先那版是用公式把形状算出来的，那条路走不通 —— 公式只会给你"某种
 * 流线型"，给不了辨识度，所以改为直接贴图。
 *
 * 放大用 `imageSmoothingEnabled = false`。这一句是像素风的命门：默认的双线性插值
 * 会把硬边糊成渐变，放大之后就不是像素画了。
 *
 * 待机**不循环播放**。眨眼是稀疏事件，一直眨看着像抽搐 —— 所以待机长期停在第 0
 * 帧，由调用方偶尔触发一次完整的四帧眨眼。
 *
 * @module pet-sprite
 */

;(() => {

/** 单帧的边长。素材是 4×4 的 256×256 表，切成三条 256×64 的横条。 */
const FRAME = 64

/** 每条动画的帧数。 */
const FRAMES = 4

/**
 * 状态到素材的映射。键就是主进程推过来的状态名 —— 多一层转换只会多一个出错的
 * 地方。
 */
const SHEETS = {
  idle: 'assets/miku-idle.png',
  attention: 'assets/miku-call.png',
  running: 'assets/miku-busy.png',
}

/** 已解码的图片，按状态存。 */
const images = new Map()

/** 全部素材就绪后置为 true；在此之前 draw 什么也不画，免得闪半张图。 */
let ready = false

/**
 * 预加载三条精灵图。
 * @returns {Promise<void>} 全部就绪后兑现；单张失败不阻塞其余，只是那个状态没图。
 */
function load() {
  const one = (state, src) => new Promise((resolve) => {
    const img = new Image()
    img.onload = () => { images.set(state, img); resolve() }
    // 少一张就少一个状态的动画，不该让整只宠物起不来。
    img.onerror = () => { console.error('[pet] 素材加载失败:', src); resolve() }
    img.src = src
  })
  return Promise.all(Object.entries(SHEETS).map(([state, src]) => one(state, src)))
    .then(() => { ready = true })
}

/**
 * 画一帧。
 *
 * @param {CanvasRenderingContext2D} ctx 目标画布
 * @param {string} state 状态名；未知状态回落到待机
 * @param {number} frame 帧序号，内部对帧数取模
 * @param {number} scale 整数放大倍数
 */
function draw(ctx, state, frame, scale) {
  if (!ready) return
  const img = images.get(state) ?? images.get('idle')
  if (img === undefined) return
  const size = FRAME * scale
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, size, size)
  const col = ((frame % FRAMES) + FRAMES) % FRAMES
  ctx.drawImage(img, col * FRAME, 0, FRAME, FRAME, 0, 0, size, size)
}

globalThis.__dshSprite = { FRAME, FRAMES, load, draw }
})()
