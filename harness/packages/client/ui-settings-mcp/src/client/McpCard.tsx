/**
 * The MCP manager's card in Settings → Plugins: the configured server list.
 *
 * Edits write straight through, with no save/discard pair. The list is a set of
 * independent switches and short strings, and the manager reacts to each change
 * by mounting or unmounting exactly the servers that changed — a staged form
 * would hide that from the user for no gain.
 */

import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { MCP_TRANSPORTS, type McpServerEntry, type McpTransport } from '../mcp-settings.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/src/client/slot-contract.ts'
import type { createMcpCardStore } from './store.ts'
import css from './McpCard.module.css'

/** Injected business face: the one durable write the card performs. */
export interface McpCardInjected {
  /** Replace the whole server list. */
  setServers: (servers: McpServerEntry[]) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type McpCardProps =
  PropsRuntime<'settings.plugin.item'> & PropsStore<ReturnType<typeof createMcpCardStore>>
  & PropsLocale<'settings.mcp'> & McpCardInjected

/** A new row: stdio is the common case, and an empty name blocks mounting until named. */
function blankServer(): McpServerEntry {
  return {
    name: '', enabled: true, transport: 'stdio',
    command: '', args: [], env: {}, url: '', headers: {},
  }
}

/**
 * Render the MCP server card.
 * @param props - composed slot props.
 * @returns the card element tree.
 */
export function McpCard({ t, useStore, setServers }: McpCardProps) {
  const servers = useStore(s => s.servers)
  const writable = useStore(s => s.writable)

  // A duplicate name silently shadows the other server's tools, so the row that
  // loses says so rather than leaving the user to wonder why it never connects.
  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const server of servers) {
    if (server.name !== '' && seen.has(server.name)) duplicated.add(server.name)
    seen.add(server.name)
  }

  const patch = (index: number, next: Partial<McpServerEntry>): void => {
    setServers(servers.map((server, at) => at === index ? { ...server, ...next } : server))
  }

  return (
    <li className={css.card}>
      <h3 className={css.title}>{t('title')}</h3>
      <p className={css.description}>{t('description')}</p>
      {!writable && <p className={css.warning}>{t('readOnly')}</p>}

      {servers.length === 0
        ? <p className={css.empty}>{t('empty')}</p>
        : (
          <ul className={css.rows}>
            {servers.map((server, index) => (
              // Rows carry no id of their own; the index is the only stable
              // handle, and every field is controlled from state, so a delete
              // re-renders the remaining rows with the right values.
              <li key={index} className={css.row}>
                <label className={css.toggle}>
                  <input
                    type="checkbox"
                    checked={server.enabled}
                    disabled={!writable}
                    onChange={(event) => { patch(index, { enabled: event.target.checked }) }}
                  />
                  {t('enabledLabel')}
                </label>

                <input
                  className={css.name}
                  value={server.name}
                  disabled={!writable}
                  placeholder={t('namePlaceholder')}
                  aria-label={t('name')}
                  onChange={(event) => { patch(index, { name: event.target.value }) }}
                />

                <select
                  className={css.transport}
                  value={server.transport}
                  disabled={!writable}
                  aria-label={t('transport')}
                  onChange={(event) => {
                    patch(index, { transport: event.target.value as McpTransport })
                  }}
                >
                  {MCP_TRANSPORTS.map(transport => (
                    <option key={transport} value={transport}>
                      {transport === 'stdio' ? t('stdio') : t('http')}
                    </option>
                  ))}
                </select>

                {server.transport === 'stdio'
                  ? (
                    <>
                      <input
                        className={css.target}
                        value={server.command}
                        disabled={!writable}
                        placeholder={t('commandPlaceholder')}
                        aria-label={t('command')}
                        onChange={(event) => { patch(index, { command: event.target.value }) }}
                      />
                      <input
                        className={css.target}
                        value={server.args.join(' ')}
                        disabled={!writable}
                        placeholder={t('argsPlaceholder')}
                        aria-label={t('args')}
                        onChange={(event) => {
                          const raw = event.target.value.trim()
                          patch(index, { args: raw === '' ? [] : raw.split(/\s+/) })
                        }}
                      />
                    </>
                  )
                  : (
                    <input
                      className={css.wideTarget}
                      value={server.url}
                      disabled={!writable}
                      placeholder={t('urlPlaceholder')}
                      aria-label={t('url')}
                      onChange={(event) => { patch(index, { url: event.target.value }) }}
                    />
                  )}

                <button
                  type="button"
                  className={css.remove}
                  disabled={!writable}
                  onClick={() => { setServers(servers.filter((_, at) => at !== index)) }}
                >
                  {t('remove')}
                </button>

                {server.name !== '' && duplicated.has(server.name)
                  && <p className={css.warning}>{t('duplicate')}</p>}
              </li>
            ))}
          </ul>
        )}

      <div className={css.footer}>
        <button
          type="button"
          className={css.add}
          disabled={!writable}
          onClick={() => { setServers([...servers, blankServer()]) }}
        >
          {t('add')}
        </button>
        <span className={css.hint}>{t('nameHint')}</span>
      </div>
      <p className={css.hint}>{t('advancedHint')}</p>
    </li>
  )
}
