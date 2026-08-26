/**
 * Nickname row slot store: a mirror of the durable pet section. The plugin's
 * apply-world subscription is the only writer; the row reads via props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { PetSettings } from '../pet-settings.ts'

/**
 * Store state mirrored from the durable section.
 *
 * Aliases the settings shape itself rather than restating it: the row writes
 * fields through a generic keyed by that type, so aliasing keeps the row, the
 * store, and the settings document from drifting as fields are added.
 */
export interface NicknameRowState extends PetSettings {
  /** Whether this deployment accepts settings writes. */
  writable: boolean
  /** Section revision; -1 until the first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type NicknameRowActions = {
  sync: (draft: NicknameRowState, next: PetSettings, writable: boolean, revision: number) => void
}

/**
 * Declares the pet row state and write surface.
 * @returns the store handle.
 */
export function createNicknameRowStore(): EngineStoreHandle<NicknameRowState, NicknameRowActions> {
  return defineStore({
    init: (): NicknameRowState => ({
      nickname: '',
      voice: false,
      voiceName: '',
      voiceRate: 1.1,
      voiceVolume: 0.85,
      voiceScope: 'alerts',
      voiceProvider: 'system',
      voiceUrl: '',
      voiceKey: '',
      voiceModel: '',
      voiceId: '',
      voiceFormat: 'mp3',
      writable: false,
      revision: -1,
    }),
    actions: {
      sync: (d, next: PetSettings, writable: boolean, revision: number) => {
        if (revision < d.revision) return
        d.nickname = next.nickname
        d.voice = next.voice
        d.voiceName = next.voiceName
        d.voiceRate = next.voiceRate
        d.voiceVolume = next.voiceVolume
        d.voiceScope = next.voiceScope
        d.voiceProvider = next.voiceProvider
        d.voiceUrl = next.voiceUrl
        d.voiceKey = next.voiceKey
        d.voiceModel = next.voiceModel
        d.voiceId = next.voiceId
        d.voiceFormat = next.voiceFormat
        d.writable = writable
        d.revision = revision
      },
    },
  })
}
