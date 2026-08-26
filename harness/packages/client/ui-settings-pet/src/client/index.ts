/**
 * Desktop pet settings, browser half: contributes the pet row to
 * Settings → General, next to Language and Appearance.
 *
 * It sits in General rather than behind a pet-specific section because these are
 * a handful of scalar preferences, and a section of its own would cost a
 * navigation row to hold them.
 */

import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the ctx.settingsScope Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import {
  MAX_NICKNAME_CHARS, PET_SETTINGS_NAMESPACE, VOICE_RATE_MAX, VOICE_RATE_MIN,
  type PetSettings, type VoiceFormat, type VoiceProvider, type VoiceScope,
} from '../pet-settings.ts'
import { NicknameRow, type NicknameRowInjected } from './NicknameRow.tsx'
import { createNicknameRowStore } from './store.ts'
import { en, zh, type PetKey } from './locales.ts'

export type { NicknameRowProps, NicknameRowInjected } from './NicknameRow.tsx'
export type { NicknameRowState } from './store.ts'
export type { PetKey } from './locales.ts'

/** Namespace owning this row's copy. */
export const SETTINGS_NS = 'settings.pet'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The pet nickname row's copy. */
    'settings.pet': PetKey
  }
}

/** Services this plugin reads. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * Register the pet row into the General section.
 * @param ctx - client cordis context.
 */
export function apply(ctx: ClientContext): void {
  const host = ctx.settingsScope.bind<PetSettings>({ namespace: PET_SETTINGS_NAMESPACE })

  ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), 'ui-settings-pet: row dictionaries')

  const store = createNicknameRowStore()
  let bound: BoundActions<typeof store> | undefined

  /** Defaults for a section the Host has not written yet. */
  const FALLBACK: PetSettings = {
    nickname: '', voice: false, voiceName: '', voiceRate: 1.1, voiceVolume: 0.85, voiceScope: 'alerts',
    voiceProvider: 'system', voiceUrl: '', voiceKey: '', voiceModel: '', voiceId: '', voiceFormat: 'mp3',
  }

  const publish = (): void => {
    const snapshot = host.getSnapshot()
    bound?.sync(snapshot.value ?? FALLBACK, snapshot.writable === true, snapshot.revision ?? 0)
  }
  ctx.effect(() => host.subscribe(publish), 'ui-settings-pet: adopt the durable nickname')

  const injected = (actions: BoundActions<typeof store>): NicknameRowInjected => {
    bound = actions
    // Re-read from the scope so nothing is lost between registration and first
    // render; the store's revision guard drops stale duplicates.
    publish()
    const clamp = (value: number, low: number, high: number): number => (
      Math.min(high, Math.max(low, Number.isFinite(value) ? value : low))
    )
    return {
      setNickname: (nickname: string) => {
        void host.set('nickname', nickname.slice(0, MAX_NICKNAME_CHARS))
      },
      setVoice: (on: boolean) => { void host.set('voice', on) },
      setVoiceName: (name: string) => { void host.set('voiceName', name) },
      // Clamped here rather than trusted from the slider: the durable value is
      // also what the pet window feeds straight into an utterance, and a rate
      // outside the accepted range makes the speech engine reject it silently.
      setVoiceRate: (rate: number) => { void host.set('voiceRate', clamp(rate, VOICE_RATE_MIN, VOICE_RATE_MAX)) },
      setVoiceVolume: (volume: number) => { void host.set('voiceVolume', clamp(volume, 0, 1)) },
      setVoiceScope: (scope: VoiceScope) => { void host.set('voiceScope', scope) },
      setVoiceProvider: (provider: VoiceProvider) => { void host.set('voiceProvider', provider) },
      setVoiceUrl: (url: string) => { void host.set('voiceUrl', url.trim()) },
      setVoiceKey: (key: string) => { void host.set('voiceKey', key.trim()) },
      setVoiceModel: (model: string) => { void host.set('voiceModel', model.trim()) },
      setVoiceId: (id: string) => { void host.set('voiceId', id.trim()) },
      setVoiceFormat: (format: VoiceFormat) => { void host.set('voiceFormat', format) },
    }
  }

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'pet-nickname',
    // After Appearance (10): a decoration preference, and the least consequential
    // row in the section belongs last.
    order: 12,
    locale: SETTINGS_NS,
    store,
    inject: injected,
  }, NicknameRow))
}
