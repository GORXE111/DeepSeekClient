/**
 * Appearance preference row registered into the General section item slot
 * (figma 501:30012 'Frame 2117131228'): the light/dark cubes, plus the palette,
 * accent, and conversation-backdrop selections. Registered by this package —
 * the theme feature owns its own settings surface. Cube selection follows the
 * persisted preference, never the resolved active theme.
 */
import clsx from 'clsx'
import {
  IconDarkOutline16, IconFollowsystemOutline16, IconLightOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemePreference } from '../theme-settings.ts'
import type { ThemeKey } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createAppearanceRowStore } from './settings-store.ts'
import { CHAT_OPACITY_MAX, CHAT_OPACITY_MIN, CHAT_PRESETS, PALETTES } from './palettes.ts'
import css from './AppearanceRow.module.css'

/** Injected business face: the preference writes (t rides the standard locale seat). */
export interface AppearanceRowInjected {
  /** Switch the light/dark preference. */
  setTheme: (id: ThemePreference) => void
  /** Switch the palette. */
  setPalette: (id: string) => void
  /** Set the custom accent as `#rrggbb`; an empty string follows the palette. */
  setAccent: (accent: string) => void
  /** Set the conversation backdrop: `none`, a preset id, or a `#rrggbb` colour. */
  setChatBackground: (value: string) => void
  /** Set the conversation backdrop strength. */
  setChatOpacity: (value: number) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type AppearanceRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createAppearanceRowStore>>
  & PropsLocale<'settings.theme'> & AppearanceRowInjected

/** Cube order and icons (figma 501:30015-30017: Light, Dark, System). */
const CUBES: readonly { id: ThemePreference; labelKey: ThemeKey; Icon: typeof IconLightOutline16 }[] = [
  { id: 'light', labelKey: 'appearance.light', Icon: IconLightOutline16 },
  { id: 'dark', labelKey: 'appearance.dark', Icon: IconDarkOutline16 },
  { id: 'system', labelKey: 'appearance.system', Icon: IconFollowsystemOutline16 },
]

/** Accent shown when the user has not set one and the palette carries none. */
const STOCK_ACCENT = '#5b7cff'

/**
 * Render the Appearance row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function AppearanceRow({
  t, useStore, setTheme, setPalette, setAccent, setChatBackground, setChatOpacity,
}: AppearanceRowComponentProps) {
  const preference = useStore(s => s.preference)
  const palette = useStore(s => s.palette)
  const accent = useStore(s => s.accent)
  const chatBackground = useStore(s => s.chatBackground)
  const chatOpacity = useStore(s => s.chatOpacity)

  const activePalette = PALETTES.find(entry => entry.id === palette)
  // A stored backdrop that is not a preset id is a custom colour; that is also
  // what puts the custom swatch in the selected state.
  const customBackdrop = chatBackground.startsWith('#')

  return (
    <div className={css.group}>
      <div className={css.title}>{t('appearance.title')}</div>
      <div className={css.cubeRow}>
        {CUBES.map(({ id, labelKey, Icon }) => (
          <button
            key={id}
            type="button"
            className={clsx(css.themeCube, preference === id && css.selected)}
            aria-pressed={preference === id}
            onClick={() => { setTheme(id) }}
          >
            <Icon />
            {t(labelKey)}
          </button>
        ))}
      </div>

      <div className={css.subTitle}>{t('palette.title')}</div>
      <div className={css.swatchRow}>
        {PALETTES.map(({ id, swatch, labelKey }) => (
          <button
            key={id}
            type="button"
            title={t(labelKey)}
            aria-label={t(labelKey)}
            className={clsx(css.swatch, palette === id && css.swatchSelected)}
            style={{ background: swatch }}
            aria-pressed={palette === id}
            onClick={() => { setPalette(id) }}
          />
        ))}
      </div>

      <div className={css.subTitle}>{t('accent.title')}</div>
      <div className={css.controlRow}>
        <input
          type="color"
          className={css.colorInput}
          aria-label={t('accent.title')}
          value={accent === '' ? (activePalette?.swatch ?? STOCK_ACCENT) : accent}
          onChange={(event) => { setAccent(event.target.value) }}
        />
        <button
          type="button"
          className={css.ghostButton}
          disabled={accent === ''}
          onClick={() => { setAccent('') }}
        >
          {t('accent.follow')}
        </button>
        <span className={css.hint}>{t('accent.hint')}</span>
      </div>

      <div className={css.subTitle}>{t('chat.title')}</div>
      <div className={css.controlRow}>
        {CHAT_PRESETS.map(({ id, labelKey, css: background }) => (
          <button
            key={id}
            type="button"
            className={clsx(css.chip, chatBackground === id && css.chipSelected)}
            aria-pressed={chatBackground === id}
            onClick={() => { setChatBackground(id) }}
          >
            {background !== undefined && <span className={css.chipSwatch} style={{ background }} />}
            {t(labelKey)}
          </button>
        ))}
        <span className={clsx(css.chip, customBackdrop && css.chipSelected)}>
          <input
            type="color"
            className={css.colorInput}
            aria-label={t('chat.custom')}
            value={customBackdrop ? chatBackground : STOCK_ACCENT}
            onChange={(event) => { setChatBackground(event.target.value) }}
          />
          {t('chat.custom')}
        </span>
      </div>
      {chatBackground !== 'none' && (
        <div className={css.controlRow}>
          <span className={css.hint}>{t('chat.strength')}</span>
          <input
            type="range"
            className={css.slider}
            aria-label={t('chat.strength')}
            min={CHAT_OPACITY_MIN}
            max={CHAT_OPACITY_MAX}
            step={0.01}
            value={chatOpacity}
            onChange={(event) => { setChatOpacity(Number(event.target.value)) }}
          />
        </div>
      )}
    </div>
  )
}
