/**
 * Appearance row slot store: a mirror of the theme service snapshot. The
 * plugin's apply-world change listener is the only writer; the row component
 * reads via props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { ThemeSettings } from '../theme-settings.ts'

/**
 * The user's full appearance selection. Deliberately the durable settings
 * shape itself rather than a parallel interface: the plugin writes fields
 * through a generic keyed by this type, so aliasing keeps the row, the store,
 * and the settings document from drifting apart as fields are added.
 */
export type AppearanceSelection = ThemeSettings

/** Store state mirrored from the theme snapshot. */
export interface AppearanceRowState extends AppearanceSelection {
  /** Service revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type AppearanceRowActions = {
  sync: (draft: AppearanceRowState, next: AppearanceSelection, revision: number) => void
}

/**
 * Declares the Appearance row state and write surface.
 * @returns the store handle.
 */
export function createAppearanceRowStore(): EngineStoreHandle<AppearanceRowState, AppearanceRowActions> {
  return defineStore({
    init: (): AppearanceRowState => ({
      preference: 'system',
      palette: 'default',
      accent: '',
      chatBackground: 'none',
      chatOpacity: 0.18,
      revision: -1,
    }),
    actions: {
      sync: (d, next: AppearanceSelection, revision: number) => {
        if (revision <= d.revision) return
        d.preference = next.preference
        d.palette = next.palette
        d.accent = next.accent
        d.chatBackground = next.chatBackground
        d.chatOpacity = next.chatOpacity
        d.revision = revision
      },
    },
  })
}
