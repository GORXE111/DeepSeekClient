/** Theme preferences stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Built-in preferences accepted at the registry and settings boundaries. */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const

/** Settings namespace owned by the theme plugin. */
export const THEME_SETTINGS_NAMESPACE = 'ui-theme'

/** Field carrying the selected built-in theme preference. */
export const THEME_PREFERENCE_FIELD = 'preference'

/** Field carrying the selected colour palette. */
export const THEME_PALETTE_FIELD = 'palette'

/** Field carrying the user's custom accent colour. */
export const THEME_ACCENT_FIELD = 'accent'

/** Field carrying the conversation backdrop selection. */
export const THEME_CHAT_FIELD = 'chatBackground'

/** Field carrying the conversation backdrop strength. */
export const THEME_CHAT_OPACITY_FIELD = 'chatOpacity'

/** Theme preference persisted by the product Appearance row. */
export type ThemePreference = typeof THEME_PREFERENCES[number]

/** Default preference when the user-settings document has no override. */
export const DEFAULT_PREFERENCE: ThemePreference = 'system'

/** Palette id meaning "keep the stock design-platform colours". */
export const DEFAULT_PALETTE = 'default'

/** Backdrop selection meaning "no conversation backdrop". */
export const DEFAULT_CHAT_BACKGROUND = 'none'

/**
 * Default backdrop strength. Deliberately low: the backdrop sits behind live
 * message text, and anything stronger starts costing legibility.
 */
export const DEFAULT_CHAT_OPACITY = 0.18

/** Durable theme section shared by the Host schema and the browser scope. */
export interface ThemeSettings {
  /** Selected built-in preference. */
  preference: ThemePreference
  /**
   * Selected palette id. Kept a free string rather than a union so an id from
   * a newer build degrades to the stock palette instead of failing the whole
   * settings document open.
   */
  palette: string
  /** Custom accent as `#rrggbb`; empty follows the palette's own accent. */
  accent: string
  /** Conversation backdrop: `none`, a preset id, or a `#rrggbb` colour. */
  chatBackground: string
  /** Conversation backdrop strength. */
  chatOpacity: number
}

/** Durable theme schema; also the wire envelope the browser scope validates against. */
export const ThemeSettingsSchema: z<ThemeSettings> = z.object({
  [THEME_PREFERENCE_FIELD]: z.union([...THEME_PREFERENCES]).default(DEFAULT_PREFERENCE),
  [THEME_PALETTE_FIELD]: z.string().default(DEFAULT_PALETTE),
  [THEME_ACCENT_FIELD]: z.string().default(''),
  [THEME_CHAT_FIELD]: z.string().default(DEFAULT_CHAT_BACKGROUND),
  [THEME_CHAT_OPACITY_FIELD]: z.number().default(DEFAULT_CHAT_OPACITY),
})

/**
 * Narrow one wire or registry value to a persistable preference.
 * @param value - value crossing the settings or registry boundary.
 * @returns whether the value is a built-in preference.
 */
export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some(preference => preference === value)
}
