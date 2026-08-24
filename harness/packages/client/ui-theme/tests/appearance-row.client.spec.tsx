// @vitest-environment jsdom
/** AppearanceRow behavior: the light/dark cubes, the palette swatches, the
 * accent, and the conversation backdrop. Selection follows the persisted
 * store mirror, never the click echo. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore, type SessionListState, type WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { AppearanceRow } from '../src/client/AppearanceRow.tsx'
import type { AppearanceRowComponentProps } from '../src/client/AppearanceRow.tsx'
import { createAppearanceRowStore, type AppearanceSelection } from '../src/client/settings-store.ts'

afterEach(cleanup)

const COPY: Record<string, string> = {
  'appearance.title': 'Appearance',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.system': 'System',
  'palette.title': 'Palette',
  'palette.default': 'Default',
  'palette.forest': 'Forest',
  'accent.title': 'Accent',
  'accent.follow': 'Follow palette',
  'chat.title': 'Chat backdrop',
  'chat.none': 'None',
  'chat.aurora': 'Aurora',
  'chat.custom': 'Custom colour',
  'chat.strength': 'Strength',
}

/** Empty global standard-kit hooks (the row reads neither). */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  return bindSnapshotSelector(store)
}

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

function mount(patch: Partial<AppearanceSelection> = {}) {
  // Real store instance — the sanctioned zero-machinery path for tests.
  const store = createAppearanceRowStore().create()
  store.actions.sync(selection(patch), 0)
  const face = {
    setTheme: vi.fn(),
    setPalette: vi.fn(),
    setAccent: vi.fn(),
    setChatBackground: vi.fn(),
    setChatOpacity: vi.fn(),
  }
  const props: AppearanceRowComponentProps = {
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    ...face,
  }
  render(<AppearanceRow {...props} />)
  return { store, ...face }
}

const pressed = (name: RegExp): string | null =>
  screen.getByRole('button', { name }).getAttribute('aria-pressed')

describe('AppearanceRow', () => {
  it('renders the title and three cubes with the preference cube selected', () => {
    mount({ preference: 'dark' })
    expect(screen.getByText('Appearance')).toBeDefined()
    expect(pressed(/Dark/)).toBe('true')
    expect(pressed(/Light/)).toBe('false')
    expect(pressed(/System/)).toBe('false')
  })

  it('click drives setTheme; selection follows the store mirror, not the click echo', () => {
    const b = mount({ preference: 'dark' })
    fireEvent.click(screen.getByRole('button', { name: /Light/ }))
    expect(b.setTheme).toHaveBeenCalledWith('light')
    // No store write yet: selection is unchanged.
    expect(pressed(/Dark/)).toBe('true')
    act(() => { b.store.actions.sync(selection({ preference: 'light' }), 1) })
    expect(pressed(/Light/)).toBe('true')
    expect(pressed(/Dark/)).toBe('false')
  })

  it('palette swatch click drives setPalette and selection mirrors the store', () => {
    const b = mount()
    expect(pressed(/Default/)).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /Forest/ }))
    expect(b.setPalette).toHaveBeenCalledWith('forest')
    expect(pressed(/Default/)).toBe('true')
    act(() => { b.store.actions.sync(selection({ palette: 'forest' }), 1) })
    expect(pressed(/Forest/)).toBe('true')
    expect(pressed(/Default/)).toBe('false')
  })

  it('accent input shows the palette swatch until the user sets one', () => {
    mount({ palette: 'forest' })
    // Forest's own accent, not a stored custom value.
    expect(screen.getByLabelText('Accent').getAttribute('value')).toBe('#3f8f6b')
  })

  it('accent reset is offered only once an accent is set', () => {
    const b = mount({ accent: '#7744ff' })
    expect(screen.getByLabelText('Accent').getAttribute('value')).toBe('#7744ff')
    const reset = screen.getByRole('button', { name: /Follow palette/ })
    expect(reset.hasAttribute('disabled')).toBe(false)
    fireEvent.click(reset)
    expect(b.setAccent).toHaveBeenCalledWith('')

    cleanup()
    mount()
    expect(screen.getByRole('button', { name: /Follow palette/ }).hasAttribute('disabled')).toBe(true)
  })

  it('backdrop chip click drives setChatBackground', () => {
    const b = mount()
    expect(pressed(/None/)).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /Aurora/ }))
    expect(b.setChatBackground).toHaveBeenCalledWith('aurora')
  })

  it('a stored colour selects the custom swatch rather than a preset', () => {
    mount({ chatBackground: '#112233' })
    expect(screen.getByLabelText('Custom colour').getAttribute('value')).toBe('#112233')
    expect(pressed(/None/)).toBe('false')
  })

  it('strength appears only once a backdrop is chosen', () => {
    mount()
    expect(screen.queryByLabelText('Strength')).toBeNull()

    cleanup()
    const b = mount({ chatBackground: 'aurora', chatOpacity: 0.3 })
    const slider = screen.getByLabelText('Strength')
    expect(slider.getAttribute('value')).toBe('0.3')
    fireEvent.change(slider, { target: { value: '0.4' } })
    expect(b.setChatOpacity).toHaveBeenCalledWith(0.4)
  })
})
