'use strict'

/**
 * 可选强调色。
 *
 * 上游的主题系统把强调色收敛在两个别名令牌上：
 *   --dsw-alias-state-business-primary    主色（按钮、光标、选中态）
 *   --dsw-alias-state-business-tertiary   同色系的浅底（悬停、标记块）
 * 亮暗两套调色板分别由 `body` 与 `body[data-ds-dark-theme]` 选中，所以每个
 * 强调色都必须给出四个值 —— 只给一套会在用户切到另一半时糊成一团。
 *
 * 上游自己有 `overrideTokens` 覆盖层接口，但那是客户端服务方法，要跑在客户端
 * 上下文里，得走 /plugins 打包管线。覆盖层的本质就是"在基础调色板之上加内联
 * CSS 变量"，所以这里直接注入等效的变量，视觉结果一致而不必碰那条管线。
 *
 * 深色档的主色刻意比浅色档更亮：深底上的同一个色值会显得更暗更闷，沿用会让
 * 按钮在夜间几乎读不出来。这是照抄上游自己的做法（它的 deepseek-500 / -400
 * 就是这么分的），不是随手挑的。
 *
 * @module accents
 */

/**
 * `default` 不给令牌：它表示"不覆盖"，让上游自己的品牌色原样生效。
 * 用一个空覆盖去"还原"默认值是行不通的 —— 还原的正确做法是不写。
 */
const ACCENTS = [
  { id: 'default', zh: '默认蓝', en: 'Default' },
  {
    id: 'teal',
    zh: '青',
    en: 'Teal',
    light: { primary: '#0d9488', tertiary: '#ccfbf1' },
    dark: { primary: '#2dd4bf', tertiary: '#134e4a' },
  },
  {
    id: 'violet',
    zh: '紫',
    en: 'Violet',
    light: { primary: '#7c3aed', tertiary: '#ede9fe' },
    dark: { primary: '#a78bfa', tertiary: '#3b2a63' },
  },
  {
    id: 'green',
    zh: '绿',
    en: 'Green',
    light: { primary: '#16a34a', tertiary: '#dcfce7' },
    dark: { primary: '#4ade80', tertiary: '#14532d' },
  },
  {
    id: 'amber',
    zh: '琥珀',
    en: 'Amber',
    light: { primary: '#c2620a', tertiary: '#fef3c7' },
    dark: { primary: '#fbbf24', tertiary: '#4a2f0a' },
  },
  {
    id: 'rose',
    zh: '玫红',
    en: 'Rose',
    light: { primary: '#e11d48', tertiary: '#ffe4e6' },
    dark: { primary: '#fb7185', tertiary: '#4c1122' },
  },
]

/** @returns 该 id 对应的强调色定义；未知 id 回落到默认而不是抛错。 */
function accentById(id) {
  return ACCENTS.find((a) => a.id === id) ?? ACCENTS[0]
}

module.exports = { ACCENTS, accentById }
