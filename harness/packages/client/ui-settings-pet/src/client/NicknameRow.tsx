/**
 * The pet nickname row in Settings → General.
 *
 * Writes straight through, with no save/discard pair: it is one short string,
 * and the pet reads it only when it next speaks, so there is nothing to stage.
 *
 * The durable section also carries spoken-alert fields (`voice*`), and this row
 * deliberately does not surface them. The Chinese voices Windows ships sound bad
 * enough that a switch for them would be offering a feature nobody keeps on; the
 * plumbing stays for whoever points it at a speech service worth using. See
 * `pet-settings.ts`.
 */

import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { COMPANIONS, MAX_NICKNAME_CHARS } from '../pet-settings.ts'
import type { createNicknameRowStore } from './store.ts'
import css from './NicknameRow.module.css'

/** Injected business face: the one durable write the row performs. */
export interface NicknameRowInjected {
  /** Store what the pet calls the user. */
  setNickname: (nickname: string) => void
  /** Choose who sits on the desktop. */
  setCharacter: (id: string) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type NicknameRowProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createNicknameRowStore>>
  & PropsLocale<'settings.pet'> & NicknameRowInjected

/**
 * Render the nickname row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function NicknameRow({ t, useStore, setNickname, setCharacter }: NicknameRowProps) {
  const nickname = useStore(s => s.nickname)
  const writable = useStore(s => s.writable)
  const character = useStore(s => s.character)
  return (
    <div className={css.group}>
      <div className={css.title}>{t('title')}</div>
      <div className={css.row}>
        <span className={css.label}>{t('companion')}</span>
        {COMPANIONS.map(one => (
          <label key={one.id} className={css.check}>
            <input
              type="radio"
              name="dsh-pet-companion"
              checked={character === one.id}
              disabled={!writable}
              onChange={() => { setCharacter(one.id) }}
            />
            {one.name}
          </label>
        ))}
      </div>
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
    </div>
  )
}
