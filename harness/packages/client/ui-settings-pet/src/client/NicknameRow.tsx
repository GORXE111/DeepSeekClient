/**
 * The pet row in Settings → General: what it calls you, and whether it speaks.
 *
 * Writes straight through, with no save/discard pair: these are short scalar
 * preferences the pet reads only when it next speaks, so there is nothing to
 * stage.
 */

import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  MAX_NICKNAME_CHARS, VOICE_FORMATS, VOICE_PROVIDERS, VOICE_RATE_MAX, VOICE_RATE_MIN,
  VOICE_SCOPES, type VoiceFormat, type VoiceProvider, type VoiceScope,
} from '../pet-settings.ts'
import type { createNicknameRowStore } from './store.ts'
import css from './NicknameRow.module.css'

/** Injected business face: the durable writes this row performs. */
export interface NicknameRowInjected {
  /** Store what the pet calls the user. */
  setNickname: (nickname: string) => void
  /** Turn spoken alerts on or off. */
  setVoice: (on: boolean) => void
  /** Choose a system voice by name; empty picks automatically. */
  setVoiceName: (name: string) => void
  /** Set the speech rate. */
  setVoiceRate: (rate: number) => void
  /** Set the speech volume. */
  setVoiceVolume: (volume: number) => void
  /** Choose what gets read aloud. */
  setVoiceScope: (scope: VoiceScope) => void
  /** Choose between the system voices and an external service. */
  setVoiceProvider: (provider: VoiceProvider) => void
  /** Set the external endpoint URL. */
  setVoiceUrl: (url: string) => void
  /** Set the external endpoint's bearer token. */
  setVoiceKey: (key: string) => void
  /** Set the model id the endpoint expects. */
  setVoiceModel: (model: string) => void
  /** Set the voice id the endpoint expects. */
  setVoiceId: (id: string) => void
  /** Set the audio encoding to request. */
  setVoiceFormat: (format: VoiceFormat) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type NicknameRowProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createNicknameRowStore>>
  & PropsLocale<'settings.pet'> & NicknameRowInjected

/**
 * The Chinese voices this machine has installed.
 *
 * Subscribes to `voiceschanged` rather than reading once: the list is populated
 * asynchronously and the first synchronous `getVoices()` on a cold window
 * returns empty, which this row would otherwise render as "no voice installed".
 *
 * Filtered to Chinese because the pet speaks Chinese. An English voice reading
 * her lines produces noise, so offering one is not a choice worth presenting.
 *
 * @returns the installed Chinese voices, re-rendering as they arrive.
 */
function useChineseVoices(): readonly SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<readonly SpeechSynthesisVoice[]>([])
  useEffect(() => {
    const synth: SpeechSynthesis | undefined = globalThis.speechSynthesis
    if (synth === undefined) return undefined
    const read = (): void => {
      setVoices(synth.getVoices().filter(voice => voice.lang.toLowerCase().startsWith('zh')))
    }
    read()
    synth.addEventListener('voiceschanged', read)
    return () => { synth.removeEventListener('voiceschanged', read) }
  }, [])
  return voices
}

/**
 * Render the pet row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function NicknameRow({
  t, useStore, setNickname, setVoice, setVoiceName, setVoiceRate, setVoiceVolume, setVoiceScope,
  setVoiceProvider, setVoiceUrl, setVoiceKey, setVoiceModel, setVoiceId, setVoiceFormat,
}: NicknameRowProps) {
  const nickname = useStore(s => s.nickname)
  const writable = useStore(s => s.writable)
  const voice = useStore(s => s.voice)
  const voiceName = useStore(s => s.voiceName)
  const voiceRate = useStore(s => s.voiceRate)
  const voiceVolume = useStore(s => s.voiceVolume)
  const voiceScope = useStore(s => s.voiceScope)
  const voiceProvider = useStore(s => s.voiceProvider)
  const voiceUrl = useStore(s => s.voiceUrl)
  const voiceKey = useStore(s => s.voiceKey)
  const voiceModel = useStore(s => s.voiceModel)
  const voiceId = useStore(s => s.voiceId)
  const voiceFormat = useStore(s => s.voiceFormat)
  const voices = useChineseVoices()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const scopeLabel = (scope: VoiceScope): string => (
    scope === 'alerts' ? t('voice.scope.alerts') : t('voice.scope.all')
  )

  const providerLabel = (provider: VoiceProvider): string => (
    provider === 'system' ? t('voice.provider.system') : t('voice.provider.http')
  )

  /** Speak one sample line with exactly the settings currently on screen. */
  const preview = async (): Promise<void> => {
    setError('')
    if (voiceProvider === 'system') {
      const synth: SpeechSynthesis | undefined = globalThis.speechSynthesis
      if (synth === undefined) return
      const chosen = voices.find(entry => entry.name === voiceName) ?? voices[0]
      if (chosen === undefined) return
      // Cancel first: repeated clicks otherwise queue and talk over each other.
      synth.cancel()
      const utterance = new SpeechSynthesisUtterance(t('voice.sample'))
      utterance.voice = chosen
      utterance.lang = chosen.lang
      utterance.rate = voiceRate
      utterance.volume = voiceVolume
      synth.speak(utterance)
      return
    }
    // Routed through the shell rather than fetched here: a direct call would hit
    // the page CSP, and the key would sit in this page's network log.
    setBusy(true)
    try {
      const response = await fetch('/__tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: t('voice.sample'),
          voiceUrl, voiceKey, voiceModel, voiceId, voiceFormat, voiceRate,
        }),
      })
      const body = await response.json() as { dataUri?: string, error?: string }
      if (!response.ok || typeof body.dataUri !== 'string') {
        setError(body.error ?? String(response.status))
        return
      }
      const audio = new Audio(body.dataUri)
      audio.volume = voiceVolume
      await audio.play()
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.group}>
      <div className={css.title}>{t('title')}</div>
      <div className={css.row}>
        <span className={css.label}>{t('nickname')}</span>
        <input
          className={css.input}
          value={nickname}
          disabled={!writable}
          maxLength={MAX_NICKNAME_CHARS}
          placeholder={t('placeholder')}
          aria-label={t('nickname')}
          onChange={(event) => { setNickname(event.target.value) }}
        />
      </div>
      <span className={css.hint}>{t('hint')}</span>

      <div className={css.subTitle}>{t('voice.title')}</div>
      <div className={css.row}>
        <label className={css.check}>
          <input
            type="checkbox"
            checked={voice}
            disabled={!writable}
            onChange={(event) => { setVoice(event.target.checked) }}
          />
          {t('voice.enable')}
        </label>
        {voices.length === 0 && <span className={css.hint}>{t('voice.none')}</span>}
      </div>

      {/* Hidden until switched on: a column of live-looking controls that drive
          nothing reads worse than not offering them yet. Not gated on having a
          system voice — an external service needs none. */}
      {voice && (
        <>
          {voiceProvider === 'system' && voices.length > 0 && (
          <div className={css.row}>
            <span className={css.label}>{t('voice.voice')}</span>
            <select
              className={css.select}
              value={voiceName}
              disabled={!writable}
              aria-label={t('voice.voice')}
              onChange={(event) => { setVoiceName(event.target.value) }}
            >
              <option value="">{t('voice.auto')}</option>
              {voices.map(entry => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
            </select>
          </div>
          )}

          <div className={css.row}>
            <span className={css.label}>{t('voice.rate')}</span>
            <input
              type="range"
              className={css.slider}
              min={VOICE_RATE_MIN}
              max={VOICE_RATE_MAX}
              step={0.05}
              value={voiceRate}
              disabled={!writable}
              aria-label={t('voice.rate')}
              onChange={(event) => { setVoiceRate(Number(event.target.value)) }}
            />
            <span className={css.label}>{t('voice.volume')}</span>
            <input
              type="range"
              className={css.slider}
              min={0}
              max={1}
              step={0.05}
              value={voiceVolume}
              disabled={!writable}
              aria-label={t('voice.volume')}
              onChange={(event) => { setVoiceVolume(Number(event.target.value)) }}
            />
          </div>

          <div className={css.row}>
            <span className={css.label}>{t('voice.scope')}</span>
            {VOICE_SCOPES.map(scope => (
              <label key={scope} className={css.check}>
                <input
                  type="radio"
                  name="dsh-pet-voice-scope"
                  checked={voiceScope === scope}
                  disabled={!writable}
                  onChange={() => { setVoiceScope(scope) }}
                />
                {scopeLabel(scope)}
              </label>
            ))}
          </div>
          <span className={css.hint}>{t('voice.hint')}</span>

          <div className={css.row}>
            <span className={css.label}>{t('voice.provider')}</span>
            {VOICE_PROVIDERS.map(provider => (
              <label key={provider} className={css.check}>
                <input
                  type="radio"
                  name="dsh-pet-voice-provider"
                  checked={voiceProvider === provider}
                  disabled={!writable}
                  onChange={() => { setVoiceProvider(provider) }}
                />
                {providerLabel(provider)}
              </label>
            ))}
          </div>

          {voiceProvider === 'http' && (
            <>
              <div className={css.row}>
                <span className={css.label}>{t('voice.url')}</span>
                <input
                  className={css.input}
                  value={voiceUrl}
                  disabled={!writable}
                  placeholder={t('voice.url.placeholder')}
                  aria-label={t('voice.url')}
                  onChange={(event) => { setVoiceUrl(event.target.value) }}
                />
                <span className={css.label}>{t('voice.key')}</span>
                <input
                  className={css.input}
                  type="password"
                  value={voiceKey}
                  disabled={!writable}
                  placeholder={t('voice.key.placeholder')}
                  aria-label={t('voice.key')}
                  onChange={(event) => { setVoiceKey(event.target.value) }}
                />
              </div>
              <div className={css.row}>
                <span className={css.label}>{t('voice.model')}</span>
                <input
                  className={css.input}
                  value={voiceModel}
                  disabled={!writable}
                  aria-label={t('voice.model')}
                  onChange={(event) => { setVoiceModel(event.target.value) }}
                />
                <span className={css.label}>{t('voice.id')}</span>
                <input
                  className={css.input}
                  value={voiceId}
                  disabled={!writable}
                  placeholder={t('voice.id.placeholder')}
                  aria-label={t('voice.id')}
                  onChange={(event) => { setVoiceId(event.target.value) }}
                />
                <select
                  className={css.select}
                  value={voiceFormat}
                  disabled={!writable}
                  aria-label={t('voice.format')}
                  onChange={(event) => { setVoiceFormat(event.target.value as VoiceFormat) }}
                >
                  {VOICE_FORMATS.map(format => <option key={format} value={format}>{format}</option>)}
                </select>
              </div>
              <span className={css.hint}>{t('voice.httpHint')}</span>
            </>
          )}

          <div className={css.row}>
            <button
              type="button"
              className={css.ghostButton}
              disabled={busy}
              onClick={() => { void preview() }}
            >
              {busy ? t('voice.testing') : t('voice.test')}
            </button>
            {error !== '' && <span className={css.hint}>{error}</span>}
          </div>
        </>
      )}
    </div>
  )
}
