/**
 * Desktop pet settings, Host half: owns the `pet` durable section.
 *
 * The section exists for the desktop shell, which has no settings surface of its
 * own — the pet lives in a frameless always-on-top window with room for a fish
 * and a sentence. Putting the preference here is what makes it reachable from
 * the place users already look for preferences.
 *
 * The shell reads the value over `settings.describe`; nothing in this package
 * talks to the pet directly.
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { PET_SETTINGS_NAMESPACE, PetSettingsSchema } from './pet-settings.ts'

export {
  MAX_NICKNAME_CHARS, PET_SETTINGS_NAMESPACE, PetSettingsSchema, type PetSettings,
} from './pet-settings.ts'

/**
 * Register the durable pet section when the settings service is composed.
 * @param ctx - Host context that may acquire the settings service.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(settingsNamespace(PET_SETTINGS_NAMESPACE), PetSettingsSchema)
  })
}
