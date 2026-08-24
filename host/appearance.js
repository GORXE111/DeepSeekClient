'use strict'

/**
 * 外观：主题预设、强调色、聊天背景。
 *
 * 上游只给三档（浅色 / 深色 / 跟随系统），因为它的主题系统是围绕"一套基础
 * 调色板 + 覆盖层"设计的，而覆盖层要客户端插件才写得进去。这里走等效的路子：
 * 把覆盖层表达成 CSS 变量注入到页面。视觉结果一致，不必碰 /plugins 打包管线。
 *
 * 一个主题只改少数几个令牌，不是全部 156 个。背景、三层表面、强调色决定了
 * 一眼看去的气质；文字与边框跟着基础调色板走，这样任何主题都不会因为我们没
 * 调到某个角落而出现读不清的地方 —— 全量覆盖看着彻底，实则每加一个上游新令牌
 * 就多一处会漏的地方。
 *
 * 每个令牌都必须给亮暗两套值。只给一套的话，用户切到另一半会看到主题"失效"，
 * 而那其实是我们没写。
 *
 * @module appearance
 */

/**
 * 内置主题。
 *
 * `default` 不含任何令牌：还原上游原貌的正确做法是"不覆盖"，而不是拿一组值
 * 去覆盖成看起来一样的东西 —— 后者会在上游调整品牌色时悄悄跑偏。
 */
const THEMES = [
  { id: 'default', zh: '默认', en: 'Default', swatch: '#5b7cff' },
  {
    id: 'warm',
    zh: '暖褐',
    en: 'Warm',
    swatch: '#b5714a',
    light: { base: '#faf6f2', l1: '#ffffff', l2: '#f5ede6', l3: '#efe4da', primary: '#b5714a', tertiary: '#f6e6da' },
    dark: { base: '#1a1613', l1: '#211c18', l2: '#272019', l3: '#2f261e', primary: '#d99b74', tertiary: '#3d2f24' },
  },
  {
    id: 'forest',
    zh: '森绿',
    en: 'Forest',
    swatch: '#3f8f6b',
    light: { base: '#f4f9f6', l1: '#ffffff', l2: '#eaf3ee', l3: '#dfece5', primary: '#2f7d5b', tertiary: '#dcf0e5' },
    dark: { base: '#101815', l1: '#152019', l2: '#1a271f', l3: '#203026', primary: '#5cbf95', tertiary: '#1e3a2c' },
  },
  {
    id: 'midnight',
    zh: '午夜',
    en: 'Midnight',
    swatch: '#5566c9',
    light: { base: '#f4f5fb', l1: '#ffffff', l2: '#ebedf7', l3: '#e0e4f2', primary: '#4553b8', tertiary: '#e2e6fb' },
    dark: { base: '#0c0e18', l1: '#11141f', l2: '#161a28', l3: '#1c2132', primary: '#8b9bff', tertiary: '#232a45' },
  },
  {
    id: 'sakura',
    zh: '樱',
    en: 'Sakura',
    swatch: '#d1698c',
    light: { base: '#fdf5f8', l1: '#ffffff', l2: '#f9ebf0', l3: '#f4dfe8', primary: '#c2557a', tertiary: '#fbe3ec' },
    dark: { base: '#1a1216', l1: '#20171b', l2: '#271c22', l3: '#2f222a', primary: '#eb8fae', tertiary: '#3d2530' },
  },
  {
    id: 'slate',
    zh: '石墨',
    en: 'Slate',
    swatch: '#64748b',
    light: { base: '#f6f7f9', l1: '#ffffff', l2: '#eef0f4', l3: '#e3e7ed', primary: '#4a5568', tertiary: '#e6eaf1' },
    dark: { base: '#0f1115', l1: '#14171d', l2: '#191d25', l3: '#20252f', primary: '#94a3b8', tertiary: '#242b36' },
  },
]

/** 令牌名到主题字段的映射。集中在一处，改名时只改这里。 */
const TOKEN_MAP = {
  base: '--dsw-alias-bg-base',
  l1: '--dsw-alias-bg-layer-1',
  l2: '--dsw-alias-bg-layer-2',
  l3: '--dsw-alias-bg-layer-3',
  primary: '--dsw-alias-state-business-primary',
  tertiary: '--dsw-alias-state-business-tertiary',
}

function themeById(id) {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

/**
 * 把一份外观偏好摊平成页面要用的形状。
 *
 * 强调色单独覆盖在主题之上：用户可能喜欢森绿的底色但想要紫色的按钮，那是两个
 * 独立的选择，不该被打成一个包。
 *
 * @param {object} prefs shell-prefs 里的外观相关字段
 * @returns {{tokens: {light: Record<string,string>, dark: Record<string,string>}, chat: object}}
 */
function resolveAppearance(prefs = {}) {
  const theme = themeById(prefs.theme)
  const light = {}
  const dark = {}
  for (const [field, token] of Object.entries(TOKEN_MAP)) {
    if (theme.light?.[field] !== undefined) light[token] = theme.light[field]
    if (theme.dark?.[field] !== undefined) dark[token] = theme.dark[field]
  }
  // 自定义强调色压在主题之上。
  if (typeof prefs.accentColor === 'string' && /^#[0-9a-f]{6}$/i.test(prefs.accentColor)) {
    light[TOKEN_MAP.primary] = prefs.accentColor
    dark[TOKEN_MAP.primary] = prefs.accentColor
  }
  return {
    tokens: { light, dark },
    chat: normalizeChat(prefs.chatBackground),
  }
}

/**
 * 归一化聊天背景配置。
 *
 * 不透明度有上限：背景压过文字就不是装饰而是障碍。用户可以调低，但调不到
 * 看不清的程度 —— 这类"能设置到坏掉"的自由度不值得给。
 */
function normalizeChat(raw) {
  if (raw === null || typeof raw !== 'object') return { kind: 'none' }
  const opacity = Math.min(Math.max(Number(raw.opacity ?? 0.18), 0), 0.45)
  if (raw.kind === 'color' && typeof raw.value === 'string') return { kind: 'color', value: raw.value, opacity }
  if (raw.kind === 'image' && typeof raw.value === 'string') return { kind: 'image', value: raw.value, opacity }
  return { kind: 'none' }
}

module.exports = { THEMES, TOKEN_MAP, themeById, resolveAppearance }
