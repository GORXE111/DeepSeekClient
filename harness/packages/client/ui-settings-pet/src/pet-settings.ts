/** Desktop pet preferences stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the pet plugin. */
export const PET_SETTINGS_NAMESPACE = 'pet'

/** Longest nickname the bubble can carry without pushing the message out of view. */
export const MAX_NICKNAME_CHARS = 16

/** Durable pet section. */
export interface PetSettings {
  /**
   * What the desktop pet calls the user. Empty means "no name" — the pet then
   * addresses nobody rather than inventing a placeholder, which reads worse than
   * saying nothing.
   */
  nickname: string
}

/** Durable pet schema; also the wire envelope the browser scope validates against. */
export const PetSettingsSchema: z<PetSettings> = z.object({
  nickname: z.string().default(''),
})
