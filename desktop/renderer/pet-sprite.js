'use strict'

/**
 * 像素宠物的绘制器。
 *
 * 做法是把一条鱼**光栅化到一张 32×24 的像素网格上**，再整体放大渲染，而不是
 * 画一张矢量图缩小 —— 后者放大后边缘会被插值糊掉，那就不是像素风了。所有形状
 * 都按整数格子判定，逐帧改尾鳍角度，于是动画是真的一帧一帧换，跟老式电子宠物
 * 一个原理。
 *
 * 调色板刻意只有五档：轮廓、主色、暗部、亮部、眼白。像素风的辨识度来自"色少
 * 而边硬"，颜色一多就变成低分辨率的插画，反而两头不靠。
 *
 * @module pet-sprite
 */

;(() => {

/** 逻辑分辨率。改大会更精细，但也更不像素 —— 32×24 是能看清鱼形的下限附近。 */
const W = 32
const H = 24

/** 调色板索引。0 是透明，画的时候跳过。 */
const T = 0, OUTLINE = 1, BODY = 2, SHADE = 3, LIGHT = 4, WHITE = 5

/**
 * 按状态取一组颜色。轮廓永远是同一档深色 —— 让轮廓跟着主色变的话，深色主题下
 * 鱼会糊进背景里。
 */
function palette(accent) {
  return {
    [OUTLINE]: '#10131a',
    [BODY]: accent,
    [SHADE]: mix(accent, '#000000', 0.34),
    [LIGHT]: mix(accent, '#ffffff', 0.42),
    [WHITE]: '#f2f5fa',
  }
}

function mix(hex, other, amount) {
  const a = parseInt(hex.slice(1), 16)
  const b = parseInt(other.slice(1), 16)
  const ch = (shift) => {
    const x = (a >> shift) & 255
    const y = (b >> shift) & 255
    return Math.round(x + (y - x) * amount)
  }
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`
}

/**
 * 画一帧。
 *
 * @param {number} frame 帧序号，决定尾鳍张合与鳍的相位
 * @param {{blink: boolean}} opts
 * @returns {Uint8Array} 长度 W*H 的调色板索引
 */
function renderFrame(frame, { blink = false } = {}) {
  const px = new Uint8Array(W * H)
  const set = (x, y, v) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    px[y * W + x] = v
  }
  const get = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? T : px[y * W + x])

  // 身体：一个椭圆。整数判定，所以边缘自然是阶梯状 —— 那正是要的。
  const cx = 13, cy = 12, rx = 9, ry = 6
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - cx) / rx
      const dy = (y - cy) / ry
      if (dx * dx + dy * dy <= 1) set(x, y, BODY)
    }
  }

  // 腹部亮面：同心但下移、更扁。
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - cx + 1) / (rx - 2)
      const dy = (y - cy - 2.2) / (ry - 3)
      if (dx * dx + dy * dy <= 1) set(x, y, LIGHT)
    }
  }
  // 背部暗面：上移，压一条窄带。
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - cx) / (rx - 2)
      const dy = (y - cy + 3.4) / 1.6
      if (dx * dx + dy * dy <= 1 && get(x, y) === BODY) set(x, y, SHADE)
    }
  }

  // 尾鳍：三角形，张合幅度按帧走。四帧一循环，闭-半-张-半。
  const spread = [2, 4, 6, 4][frame % 4]
  for (let i = 0; i < 7; i++) {
    const x = cx + rx - 1 + i
    const half = Math.round((i / 6) * spread) + 1
    for (let dy = -half; dy <= half; dy++) set(x, cy + dy, i > 4 ? SHADE : BODY)
  }

  // 背鳍：跟着尾巴反相摆，幅度小。
  const finLift = [0, 1, 1, 0][frame % 4]
  for (let i = 0; i < 5; i++) {
    const x = cx - 2 + i
    const top = cy - ry - finLift - (i < 3 ? i : 4 - i)
    for (let y = top; y < cy - ry + 1; y++) set(x, y, SHADE)
  }

  // 眼睛：白底 + 瞳孔。眨眼时压成一条线。
  if (blink) {
    for (let i = 0; i < 3; i++) set(cx - 5 + i, cy - 1, OUTLINE)
  } else {
    for (let y = cy - 3; y <= cy; y++) {
      for (let x = cx - 6; x <= cx - 3; x++) set(x, y, WHITE)
    }
    set(cx - 4, cy - 2, OUTLINE)
    set(cx - 4, cy - 1, OUTLINE)
    set(cx - 5, cy - 2, OUTLINE)
  }

  // 描边：任何非透明像素，若四邻有透明，就在那个透明格子上落一笔轮廓。
  // 先收集再落笔，否则新画的轮廓会被当成实体继续外扩，鱼会一圈圈胖起来。
  const edge = []
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (get(x, y) !== T) continue
      if (get(x - 1, y) !== T || get(x + 1, y) !== T || get(x, y - 1) !== T || get(x, y + 1) !== T) {
        edge.push([x, y])
      }
    }
  }
  for (const [x, y] of edge) set(x, y, OUTLINE)

  return px
}

/** 把一帧画到 canvas 上。canvas 的像素尺寸必须是 W*scale × H*scale。 */
function paint(ctx, px, accent, scale) {
  const colors = palette(accent)
  ctx.clearRect(0, 0, W * scale, H * scale)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = px[y * W + x]
      if (v === T) continue
      ctx.fillStyle = colors[v]
      ctx.fillRect(x * scale, y * scale, scale, scale)
    }
  }
}

globalThis.__dshSprite = { W, H, renderFrame, paint }
})()
