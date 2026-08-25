/**
 * Colour palettes, custom accent, and conversation backdrops for the
 * Appearance row.
 *
 * Palettes ship as token pairs rather than as registered themes: a theme id is
 * the light/dark *preference*, and a user who picks "Forest" still expects the
 * light/dark switch to keep working. Layering tokens over whichever base
 * palette is active keeps those two choices independent, which is why every
 * palette carries both a light and a dark column.
 *
 * The accent is layered last, so it wins over the palette's own accent —
 * "Forest ground, purple buttons" is a combination a user can ask for and get.
 */
import type { ThemeTokenOverrides } from './index.ts'
import type { ThemeKey } from './locales.ts'

/** Palette slots, in the order they are written into the override layer. */
const TOKEN_KEYS = ['base', 'l1', 'l2', 'l3', 'primary', 'tertiary'] as const

/** One palette slot name. */
type PaletteKey = typeof TOKEN_KEYS[number]

/** A full colour column (one per palette mode). */
type PaletteColumn = Record<PaletteKey, string>

/** Slot to alias-token mapping. Centralised so a token rename lands here only. */
const TOKEN_MAP: Record<PaletteKey, string> = {
  base: '--dsw-alias-bg-base',
  l1: '--dsw-alias-bg-layer-1',
  l2: '--dsw-alias-bg-layer-2',
  l3: '--dsw-alias-bg-layer-3',
  primary: '--dsw-alias-state-business-primary',
  tertiary: '--dsw-alias-state-business-tertiary',
}

/** One selectable palette. */
export interface Palette {
  /** Persisted id. */
  id: string
  /** Swatch colour shown in the row. */
  swatch: string
  /** Row label key. */
  labelKey: ThemeKey
  /** Light column; absent on `default`, which keeps the stock palette. */
  light?: PaletteColumn
  /** Dark column; absent on `default`. */
  dark?: PaletteColumn
}

/** Selectable palettes, in row order. */
export const PALETTES: readonly Palette[] = [
  { id: 'default', swatch: '#5b7cff', labelKey: 'palette.default' },
  {
    id: 'warm',
    swatch: '#b5714a',
    labelKey: 'palette.warm',
    light: { base: '#faf6f2', l1: '#ffffff', l2: '#f5ede6', l3: '#efe4da', primary: '#b5714a', tertiary: '#f6e6da' },
    dark: { base: '#1a1613', l1: '#211c18', l2: '#272019', l3: '#2f261e', primary: '#d99b74', tertiary: '#3d2f24' },
  },
  {
    id: 'forest',
    swatch: '#3f8f6b',
    labelKey: 'palette.forest',
    light: { base: '#f4f9f6', l1: '#ffffff', l2: '#eaf3ee', l3: '#dfece5', primary: '#2f7d5b', tertiary: '#dcf0e5' },
    dark: { base: '#101815', l1: '#152019', l2: '#1a271f', l3: '#203026', primary: '#5cbf95', tertiary: '#1e3a2c' },
  },
  {
    id: 'midnight',
    swatch: '#5566c9',
    labelKey: 'palette.midnight',
    light: { base: '#f4f5fb', l1: '#ffffff', l2: '#ebedf7', l3: '#e0e4f2', primary: '#4553b8', tertiary: '#e2e6fb' },
    dark: { base: '#0c0e18', l1: '#11141f', l2: '#161a28', l3: '#1c2132', primary: '#8b9bff', tertiary: '#232a45' },
  },
  {
    id: 'sakura',
    swatch: '#d1698c',
    labelKey: 'palette.sakura',
    light: { base: '#fdf5f8', l1: '#ffffff', l2: '#f9ebf0', l3: '#f4dfe8', primary: '#c2557a', tertiary: '#fbe3ec' },
    dark: { base: '#1a1216', l1: '#20171b', l2: '#271c22', l3: '#2f222a', primary: '#eb8fae', tertiary: '#3d2530' },
  },
  {
    id: 'slate',
    swatch: '#64748b',
    labelKey: 'palette.slate',
    light: { base: '#f6f7f9', l1: '#ffffff', l2: '#eef0f4', l3: '#e3e7ed', primary: '#4a5568', tertiary: '#e6eaf1' },
    dark: { base: '#0f1115', l1: '#14171d', l2: '#191d25', l3: '#20252f', primary: '#94a3b8', tertiary: '#242b36' },
  },
]

/** A stored accent or custom backdrop colour. */
const HEX = /^#[0-9a-fA-F]{6}$/

/** One selectable conversation backdrop. */
export interface ChatPreset {
  /** Persisted id. */
  id: string
  /** Row label key. */
  labelKey: ThemeKey
  /** CSS `background` used while the light palette is active; absent on `none`. */
  light?: string
  /** CSS `background` used while the dark palette is active; absent on `none`. */
  dark?: string
}

/**
 * Backdrop presets, in row order. A custom colour is stored as its own hex.
 *
 * 每个预设都有明暗两套，而不是一套配色靠透明度去适配两种主题：背景要垫在正文
 * 之下，浅色主题下必须**比底色深**、深色主题下必须**比底色浅**才看得见。同一
 * 组浅色渐变压到 18% 盖在白底上几乎消失，那不是"淡"，是溶掉了。
 */
export const CHAT_PRESETS: readonly ChatPreset[] = [
  { id: 'none', labelKey: 'chat.none' },
  {
    id: 'aurora',
    labelKey: 'chat.aurora',
    light: 'linear-gradient(135deg, #2540b8, #0e8f86 55%, #5b2fb0)',
    dark: 'linear-gradient(135deg, #8fb0ff, #6ff0de 55%, #c49bff)',
  },
  {
    id: 'dusk',
    labelKey: 'chat.dusk',
    light: 'linear-gradient(160deg, #b4155c, #c2410c)',
    dark: 'linear-gradient(160deg, #ff9ebd, #ffbe98)',
  },
  {
    id: 'mint',
    labelKey: 'chat.mint',
    light: 'linear-gradient(140deg, #0f766e, #15803d)',
    dark: 'linear-gradient(140deg, #7ff0dd, #c3f7d2)',
  },
  {
    id: 'ember',
    labelKey: 'chat.ember',
    light: 'linear-gradient(150deg, #b45309, #9f1239)',
    dark: 'linear-gradient(150deg, #fcc652, #ff9a8b)',
  },
]

/** Lower strength bound. */
export const CHAT_OPACITY_MIN = 0.04

/** Upper strength bound for gradients; above it the backdrop eats message text. */
export const CHAT_OPACITY_MAX = 0.45

/**
 * Upper strength bound for a wallpaper.
 *
 * Higher than a gradient's on purpose. A gradient is a wash of saturated colour
 * straight under the text, so it costs legibility fast. A photo at the same 45%
 * is barely a photo any more — the whole point of picking one is to see it. The
 * text keeps its own ground (bubbles and cards paint over the layer), so the
 * ceiling that matters here is taste, not contrast.
 */
export const WALLPAPER_OPACITY_MAX = 1

/** Prefix marking a backdrop selection that names a stored wallpaper. */
export const WALLPAPER_PREFIX = 'wallpaper:'

/**
 * Shell route serving one stored wallpaper. Desktop-only: in a browser the
 * path falls through to the Host and 404s, which is why the picker hides
 * itself when the listing request fails.
 */
export const WALLPAPER_ROUTE = '/__wallpaper'

/**
 * The wallpaper id inside a backdrop selection.
 * @param selection - persisted `chatBackground` value.
 * @returns the id, or undefined when the selection is not a wallpaper.
 */
export function wallpaperId(selection: string): string | undefined {
  if (!selection.startsWith(WALLPAPER_PREFIX)) return undefined
  const id = selection.slice(WALLPAPER_PREFIX.length)
  return /^[0-9a-f]{16}$/.test(id) ? id : undefined
}

/**
 * Strength ceiling for one selection.
 * @param selection - persisted `chatBackground` value.
 * @returns the maximum the slider may reach.
 */
export function maxOpacityFor(selection: string): number {
  return wallpaperId(selection) === undefined ? CHAT_OPACITY_MAX : WALLPAPER_OPACITY_MAX
}

/**
 * Build the palette-plus-accent override layer.
 * @param paletteId - persisted palette id; an unknown id keeps the stock palette.
 * @param accent - custom accent as `#rrggbb`; anything else is ignored.
 * @returns the override layer to hand to `ThemeRuntime.overrideTokens`.
 */
export function buildOverrides(paletteId: string, accent: string): ThemeTokenOverrides {
  const tokens: ThemeTokenOverrides = {}
  const palette = PALETTES.find(entry => entry.id === paletteId)
  const light = palette?.light
  const dark = palette?.dark
  if (light !== undefined && dark !== undefined) {
    for (const key of TOKEN_KEYS) tokens[TOKEN_MAP[key]] = { light: light[key], dark: dark[key] }
  }
  if (HEX.test(accent)) {
    // Written after the palette so a custom accent wins over the palette's own.
    tokens[TOKEN_MAP.primary] = { light: accent, dark: accent }
    // The tertiary is the accent's soft fill (hover grounds, selected rows), so
    // it has to stay a *tint*: mixed toward each mode's own ground rather than
    // reused at full strength, which would read as a second primary and flatten
    // the two states into one.
    tokens[TOKEN_MAP.tertiary] = {
      light: `color-mix(in srgb, ${accent} 14%, #ffffff)`,
      dark: `color-mix(in srgb, ${accent} 26%, #000000)`,
    }
  }
  return tokens
}

/**
 * The `background` shorthand painting one wallpaper.
 *
 * `cover` + `center`, no repeat: a photo tiled at its native size reads as a
 * bug, and one letterboxed inside the column reads as a broken layout. Cropping
 * is the only fit that stays invisible.
 *
 * The id is validated by `wallpaperId` before it reaches here, so it cannot
 * carry anything that would escape the `url()`.
 *
 * @param id - stored wallpaper id.
 * @returns the CSS `background` value.
 */
function wallpaperLayer(id: string): string {
  return `center / cover no-repeat url('${WALLPAPER_ROUTE}/${id}')`
}

/**
 * Build the conversation backdrop stylesheet.
 *
 * Anchored on `[data-conversation-backdrop]` — the whole conversation column,
 * which does not itself scroll. The obvious target is the scrollport, but an
 * absolutely positioned layer inside a scrolling box **scrolls away with the
 * content**: the backdrop then covers the first screenful and leaves everything
 * below it, the composer included, bare. The header keeps its own separation by
 * sitting over the layer as frosted glass, not by being excluded from it.
 *
 * Painted by a pseudo-element rather than as the element's own `background` so
 * the strength slider can drive `opacity` on the layer alone — set on the
 * element it would fade the transcript with it. The layer must also stay out of
 * hit-testing, or message text stops being selectable.
 *
 * Presets carry one gradient per palette mode: a backdrop sits under body text,
 * so it has to be darker than a light ground and lighter than a dark one. A
 * custom colour is used as picked in both modes — it is the user's own choice
 * and it has to match the swatch they clicked.
 *
 * @param selection - `none`, a preset id, or a `#rrggbb` colour.
 * @param opacity - backdrop strength; clamped to the documented bounds.
 * @returns the stylesheet text, empty when no backdrop is selected.
 */
export function buildBackdropCss(selection: string, opacity: number): string {
  const wallpaper = wallpaperId(selection)
  const preset = CHAT_PRESETS.find(entry => entry.id === selection)
  // 自定义纯色的入口已经从面板上撤掉（换成了壁纸），但读取仍然保留：早先存下的
  // 那个值不该在升级之后无声地变成"无背景"。
  const custom = HEX.test(selection) ? selection : undefined
  const light = wallpaper !== undefined ? wallpaperLayer(wallpaper) : preset?.light ?? custom
  const dark = wallpaper !== undefined ? wallpaperLayer(wallpaper) : preset?.dark ?? custom
  if (light === undefined || dark === undefined) return ''
  const strength = Math.min(maxOpacityFor(selection), Math.max(CHAT_OPACITY_MIN, opacity))

  return [
    '[data-conversation-backdrop] { position: relative; }',
    '[data-conversation-backdrop]::before {',
    "  content: '';",
    '  position: absolute;',
    '  inset: 0;',
    '  pointer-events: none;',
    '  z-index: 0;',
    `  opacity: ${strength};`,
    `  background: ${light};`,
    '}',
    `body[data-ds-dark-theme] [data-conversation-backdrop]::before { background: ${dark}; }`,
    // 内容要压在背景之上，否则会被伪元素盖住。
    '[data-conversation-backdrop] > * { position: relative; z-index: 1; }',

    // 输入框座自带一层"输入遮罩"：从透明淡入到**纯底色**，用来把滚到它下面的
    // 消息挡住。那段纯色会把壁纸一起盖掉，于是输入框那一带出现一条突兀的色带。
    //
    // 选了背景就把遮罩整个透明掉，让壁纸连成一片。代价是滚动时消息会从输入卡片
    // 四周的空隙里淡淡透出来 —— 这是明知的取舍：背景本就是装饰，断成两截比透出
    // 一点更难看。没选背景时这条规则不生成，上游的遮罩原样保留。
    '[data-conversation-backdrop] [data-composer-seat] { background: transparent !important; }',

    // 标题行做成雾面玻璃：半透明底色 + 背景模糊。壁纸在它下面透上来但被打散，
    // 于是这一条既和侧边栏拉开层次，又不会让标签直接压在渐变上而难读。
    //
    // 只在选了背景时才生成 —— 没有东西可透时，模糊什么也做不了，剩下的只是一层
    // 平白的色差。
    '[data-conversation-backdrop] [data-conversation-header] {',
    '  background: color-mix(in srgb, var(--dsw-alias-bg-base) 58%, transparent);',
    '  backdrop-filter: blur(20px) saturate(140%);',
    '  -webkit-backdrop-filter: blur(20px) saturate(140%);',
    '}',
  ].join('\n')
}
