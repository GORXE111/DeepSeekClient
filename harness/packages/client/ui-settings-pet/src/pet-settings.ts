/** Desktop pet preferences stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the pet plugin. */
export const PET_SETTINGS_NAMESPACE = 'pet'

/** Longest nickname the bubble can carry without pushing the message out of view. */
export const MAX_NICKNAME_CHARS = 16

/*
 * Spoken alerts are wired but unsurfaced. See the `voice` field below for why;
 * the constants and unions here stay because the durable schema still validates
 * those fields, and a document that already carries them must keep parsing.
 */

/** Speech rate bounds. Outside these the voice stops being intelligible. */
export const VOICE_RATE_MIN = 0.7

/** Upper speech-rate bound. */
export const VOICE_RATE_MAX = 1.6

/** Where the speech comes from, in row order. */
export const VOICE_PROVIDERS = ['system', 'http'] as const

/** Where the speech comes from. */
export type VoiceProvider = typeof VOICE_PROVIDERS[number]

/** Audio encodings an OpenAI-compatible speech endpoint may return. */
export const VOICE_FORMATS = ['mp3', 'wav', 'opus', 'aac', 'flac'] as const

/** Audio encoding requested from the external service. */
export type VoiceFormat = typeof VOICE_FORMATS[number]

/** What the pet reads aloud, in row order. */
export const VOICE_SCOPES = ['alerts', 'all'] as const

/** What the pet reads aloud. */
export type VoiceScope = typeof VOICE_SCOPES[number]

/** Durable pet section. */
export interface PetSettings {
  /**
   * What the desktop pet calls the user. Empty means "no name" — the pet then
   * addresses nobody rather than inventing a placeholder, which reads worse than
   * saying nothing.
   */
  nickname: string
  /**
   * Read notifications aloud.
   *
   * **No settings row drives this**, and it stays false unless someone edits the
   * user-settings document by hand. The plumbing works end to end; what does not
   * work is the sound — the Chinese voices Windows ships read like a public
   * address system, and an external service is the only way to get something
   * worth hearing. Rather than ship a switch nobody would keep on, the whole
   * path is left in place as an extension point: set this true, fill in
   * `voiceProvider: http` plus the endpoint fields, and the pet speaks.
   */
  voice: boolean
  /**
   * Chosen system voice by name; empty picks the youngest-sounding Chinese
   * voice installed. Stored as a free string because the available set is a
   * property of the machine, not of this build — a name that disappears simply
   * falls back to the automatic pick.
   */
  voiceName: string
  /**
   * Speech rate. There is deliberately no pitch field: on Windows the pitch
   * control is a no-op (measured — the fundamental moves under 5% across the
   * entire range), and a knob that does nothing is worse than no knob.
   */
  voiceRate: number
  /** Speech volume, 0 to 1. */
  voiceVolume: number
  /**
   * `alerts` reads only the things that are asking for you — a finished task,
   * an approval, a question, an error. `all` also reads her chat answers, which
   * you are usually looking straight at when they arrive.
   */
  voiceScope: VoiceScope
  /**
   * `system` uses whatever voices the machine has — offline and free, but the
   * installed Chinese voices are the decade-old SAPI set and read like an
   * announcement rather than a person.
   *
   * `http` posts to an OpenAI-compatible `/v1/audio/speech` endpoint, which is
   * the only route to a genuinely cute voice. Nothing is bundled: there is no
   * official Miku speech synthesizer to bundle, and community voice clones are
   * trained on the Vocaloid voicebank, which the character's CC BY-NC licence
   * does not cover. Which service and which voice is the user's own call.
   */
  voiceProvider: VoiceProvider
  /** Full endpoint URL, e.g. `https://…/v1/audio/speech`. */
  voiceUrl: string
  /**
   * Bearer token for that endpoint. Stored in the plain-text user-settings
   * document like every other field here — this is a single-user desktop app,
   * and a separate secret store for one optional key would be ceremony without
   * a threat it defends against.
   */
  voiceKey: string
  /** Model id the endpoint expects; many local servers ignore it. */
  voiceModel: string
  /** Voice id the endpoint expects. This is where "which cute voice" is chosen. */
  voiceId: string
  /** Audio encoding to request. */
  voiceFormat: VoiceFormat
}

/** Durable pet schema; also the wire envelope the browser scope validates against. */
export const PetSettingsSchema: z<PetSettings> = z.object({
  nickname: z.string().default(''),
  voice: z.boolean().default(false),
  voiceName: z.string().default(''),
  voiceRate: z.number().default(1.1),
  voiceVolume: z.number().default(0.85),
  voiceScope: z.union([...VOICE_SCOPES]).default('alerts'),
  voiceProvider: z.union([...VOICE_PROVIDERS]).default('system'),
  voiceUrl: z.string().default(''),
  voiceKey: z.string().default(''),
  voiceModel: z.string().default(''),
  voiceId: z.string().default(''),
  voiceFormat: z.union([...VOICE_FORMATS]).default('mp3'),
})
