/**
 * MCP manager, Host half: owns the `mcp-servers` durable section and mounts one
 * MCP client plugin per enabled entry.
 *
 * The shipped way to attach an MCP server is a `cordis.yml` entry per server.
 * That is fine for a deployment someone edits by hand, but it puts the whole
 * capability out of reach of the running application: nothing in the API surface
 * touches loader configuration, so a settings panel could only ever display what
 * a file already said. Moving the list into settings is what makes the servers
 * manageable from the product at all.
 *
 * Mounting is diffed rather than rebuilt: a server keeps its connection, and its
 * tool generation, as long as its own configuration is unchanged. Rebuilding the
 * whole set on every edit would drop every server's tools for the duration of a
 * rename elsewhere in the list.
 */

import type { Context } from '@deepseek-ai/cordis'
// 函数式插件按命名空间引入：这类插件具名导出 name/inject/Config/apply，没有
// 默认导出，混用两种形式会让 Loader 丢掉它的命名空间。
import * as MCPClient from '@deepseek-ai/dsh-mcp-client'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  isMountable, MCP_SETTINGS_NAMESPACE, McpSettingsSchema,
  type McpServerEntry, type McpSettings,
} from './mcp-settings.ts'

export {
  isMountable, MCP_SETTINGS_NAMESPACE, MCP_TRANSPORTS, McpSettingsSchema,
  type McpServerEntry, type McpSettings, type McpTransport,
} from './mcp-settings.ts'

const NAMESPACE = settingsNamespace(MCP_SETTINGS_NAMESPACE)

/** One mounted server: the fiber plus the config fingerprint that produced it. */
interface Mounted {
  /** Serialized config; an unchanged fingerprint means the fiber can stay. */
  key: string
  /** The plugin fiber, disposed when the entry changes or disappears. */
  fiber: { dispose: () => unknown }
}

/**
 * Translate one entry into the MCP client plugin's config.
 * @param entry - a mountable server entry.
 * @returns config for the transport the entry names.
 */
function toConfig(entry: McpServerEntry): object {
  return entry.transport === 'stdio'
    ? {
      transport: 'stdio',
      serverName: entry.name,
      command: entry.command,
      args: entry.args,
      env: entry.env,
    }
    : {
      transport: 'streamable-http',
      serverName: entry.name,
      url: entry.url,
      headers: entry.headers,
    }
}

/**
 * Register the durable MCP section and keep the mounted servers matching it.
 * @param ctx - Host context that may acquire the settings service.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(NAMESPACE, McpSettingsSchema)
    const mounted = new Map<string, Mounted>()

    const sync = (settings: McpSettings): void => {
      const wanted = new Map<string, { key: string; config: object }>()
      for (const entry of settings.servers) {
        if (!isMountable(entry)) continue
        // Tool names carry the server name, so two entries sharing one name would
        // shadow each other's tools. First wins; the panel flags the duplicate.
        if (wanted.has(entry.name)) continue
        const config = toConfig(entry)
        wanted.set(entry.name, { key: JSON.stringify(config), config })
      }

      for (const [name, live] of [...mounted]) {
        const next = wanted.get(name)
        if (next !== undefined && next.key === live.key) continue
        void live.fiber.dispose()
        mounted.delete(name)
      }
      for (const [name, next] of wanted) {
        if (mounted.has(name)) continue
        mounted.set(name, {
          key: next.key,
          fiber: ctx.plugin(MCPClient, next.config as MCPClient.Config),
        })
      }
    }

    sync(scope.get())
    settingsCtx.effect(
      () => scope.watch((next) => { sync(next) }),
      'mcp-manager: remount servers on settings change',
    )
    settingsCtx.effect(() => () => {
      for (const live of mounted.values()) void live.fiber.dispose()
      mounted.clear()
    }, 'mcp-manager: unmount servers on dispose')
  })
}
