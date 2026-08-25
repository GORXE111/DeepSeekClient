/**
 * MCP manager, browser half: contributes the server-list card to Settings →
 * Plugins. The card is keyed by the `mcp-servers` namespace, so it appears only
 * where the Host half actually registered that section.
 */

import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the ctx.settingsScope Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the Plugins tab owns the `settings.plugin.item` slot type.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/src/client/slot-contract.ts'
import { MCP_SETTINGS_NAMESPACE, type McpServerEntry, type McpSettings } from '../mcp-settings.ts'
import { McpCard, type McpCardInjected } from './McpCard.tsx'
import { createMcpCardStore } from './store.ts'
import { en, zh, type McpKey } from './locales.ts'

export type { McpCardProps, McpCardInjected } from './McpCard.tsx'
export type { McpCardState } from './store.ts'
export type { McpKey } from './locales.ts'

/** Namespace owning this card's copy. */
export const SETTINGS_NS = 'settings.mcp'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The MCP server card's copy. */
    'settings.mcp': McpKey
  }
}

/** Services this plugin reads. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * Register the MCP server card into the Plugins tab.
 * @param ctx - client cordis context.
 */
export function apply(ctx: ClientContext): void {
  const host = ctx.settingsScope.bind<McpSettings>({ namespace: MCP_SETTINGS_NAMESPACE })

  ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), 'ui-settings-mcp: card dictionaries')

  const store = createMcpCardStore()
  let bound: BoundActions<typeof store> | undefined

  const publish = (): void => {
    const snapshot = host.getSnapshot()
    bound?.sync(snapshot.value?.servers ?? [], snapshot.writable === true, snapshot.revision ?? 0)
  }
  ctx.effect(() => host.subscribe(publish), 'ui-settings-mcp: adopt the durable server list')

  const injected = (actions: BoundActions<typeof store>): McpCardInjected => {
    bound = actions
    // Re-read from the scope so nothing is lost between registration and first
    // render; the store's revision guard drops stale duplicates.
    publish()
    return {
      setServers: (servers: McpServerEntry[]) => { void host.set('servers', servers) },
    }
  }

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: MCP_SETTINGS_NAMESPACE,
    locale: SETTINGS_NS,
    store,
    inject: injected,
  }, McpCard))
}
