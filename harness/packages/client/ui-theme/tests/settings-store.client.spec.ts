/** Appearance row store: snapshot-mirror action and the revision guard. */
import { describe, expect, it } from 'vitest'
import { createAppearanceRowStore, type AppearanceSelection } from '../src/client/settings-store.ts'

/** Default selection with only the fields a case cares about overridden. */
function selection(patch: Partial<AppearanceSelection> = {}): AppearanceSelection {
  return {
    preference: 'system',
    palette: 'default',
    accent: '',
    chatBackground: 'none',
    chatOpacity: 0.18,
    ...patch,
  }
}

describe('createAppearanceRowStore', () => {
  it('init shape: stock selection with revision at -1', () => {
    const store = createAppearanceRowStore().create()
    expect(store.getSnapshot()).toEqual({ ...selection(), revision: -1 })
  })

  it('sync mirrors the whole selection and advances the revision', () => {
    const store = createAppearanceRowStore().create()
    store.actions.sync(selection({ preference: 'dark' }), 0)
    expect(store.getSnapshot()).toEqual({ ...selection({ preference: 'dark' }), revision: 0 })
    store.actions.sync(selection({
      preference: 'light',
      palette: 'forest',
      accent: '#7744ff',
      chatBackground: 'aurora',
      chatOpacity: 0.3,
    }), 2)
    expect(store.getSnapshot()).toEqual({
      preference: 'light',
      palette: 'forest',
      accent: '#7744ff',
      chatBackground: 'aurora',
      chatOpacity: 0.3,
      revision: 2,
    })
  })

  it('revision guard drops stale and duplicate writes', () => {
    const store = createAppearanceRowStore().create()
    store.actions.sync(selection({ preference: 'dark' }), 3)
    store.actions.sync(selection({ preference: 'system' }), 2)
    store.actions.sync(selection({ preference: 'system' }), 3)
    expect(store.getSnapshot().preference).toBe('dark')
    expect(store.getSnapshot().revision).toBe(3)
  })
})
