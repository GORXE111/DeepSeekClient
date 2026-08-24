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
  /** CSS `background` value; absent on `none`. */
  css?: string
}

/** Backdrop presets, in row order. A custom colour is stored as its own hex. */
export const CHAT_PRESETS: readonly ChatPreset[] = [
  { id: 'none', labelKey: 'chat.none' },
  { id: 'aurora', labelKey: 'chat.aurora', css: 'linear-gradient(135deg, #5b7cff, #47d6c0 55%, #9d6bff)' },
  { id: 'dusk', labelKey: 'chat.dusk', css: 'linear-gradient(160deg, #f2709c, #ff9472)' },
  { id: 'mint', labelKey: 'chat.mint', css: 'linear-gradient(140deg, #43c6ac, #d7f9ef)' },
  { id: 'ember', labelKey: 'chat.ember', css: 'linear-gradient(150deg, #f7971e, #cf3d3d)' },
]

/** Lower strength bound. */
export const CHAT_OPACITY_MIN = 0.04

/** Upper strength bound; above it the backdrop starts eating message text. */
export const CHAT_OPACITY_MAX = 0.45

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
 * Build the conversation backdrop stylesheet.
 *
 * The backdrop is painted by a pseudo-element rather than set as the scroll
 * container's own `background`: that container scrolls, and a background set on
 * it scrolls away with the content instead of staying put behind it. The layer
 * also must not take pointer events, or message text stops being selectable.
 *
 * @param selection - `none`, a preset id, or a `#rrggbb` colour.
 * @param opacity - backdrop strength; clamped to the documented bounds.
 * @returns the stylesheet text, empty when no backdrop is selected.
 */
export function buildBackdropCss(selection: string, opacity: number): string {
  const preset = CHAT_PRESETS.find(entry => entry.id === selection)
  const background = preset?.css ?? (HEX.test(selection) ? selection : undefined)
  if (background === undefined) return ''
  const strength = Math.min(CHAT_OPACITY_MAX, Math.max(CHAT_OPACITY_MIN, opacity))
  return [
    '[data-conversation-scroll] { position: relative; }',
    '[data-conversation-scroll]::before {',
    "  content: '';",
    '  position: absolute;',
    '  inset: 0;',
    '  pointer-events: none;',
    '  z-index: 0;',
    `  opacity: ${strength};`,
    `  background: ${background};`,
    '}',
    '[data-conversation-scroll] > * { position: relative; z-index: 1; }',
  ].join('\n')
}
