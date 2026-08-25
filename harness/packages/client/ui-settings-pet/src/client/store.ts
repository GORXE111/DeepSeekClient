/**
 * Nickname row slot store: a mirror of the durable pet section. The plugin's
 * apply-world subscription is the only writer; the row reads via props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Store state mirrored from the durable section. */
export interface NicknameRowState {
  /** What the pet calls the user; empty means no name. */
  nickname: string
  /** Whether this deployment accepts settings writes. */
  writable: boolean
  /** Section revision; -1 until the first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type NicknameRowActions = {
  sync: (draft: NicknameRowState, nickname: string, writable: boolean, revision: number) => void
}

/**
 * Declares the nickname row state and write surface.
 * @returns the store handle.
 */
export function createNicknameRowStore(): EngineStoreHandle<NicknameRowState, NicknameRowActions> {
  return defineStore({
    init: (): NicknameRowState => ({ nickname: '', writable: false, revision: -1 }),
    actions: {
      sync: (d, nickname: string, writable: boolean, revision: number) => {
        if (revision < d.revision) return
        d.nickname = nickname
        d.writable = writable
        d.revision = revision
      },
    },
  })
}
