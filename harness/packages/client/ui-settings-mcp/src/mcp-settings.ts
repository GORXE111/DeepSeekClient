/** MCP server list stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the MCP manager plugin. */
export const MCP_SETTINGS_NAMESPACE = 'mcp-servers'

/** Transports the MCP client plugin accepts. */
export const MCP_TRANSPORTS = ['stdio', 'streamable-http'] as const

/** One transport name. */
export type McpTransport = typeof MCP_TRANSPORTS[number]

/**
 * One configured server.
 *
 * The two transports need disjoint fields, but the entry keeps both sets flat
 * rather than splitting into a union: the settings document is hand-editable
 * and a union renders there as an unlabelled either/or, while the unused half
 * simply stays empty and costs nothing. The manager reads only the fields its
 * transport names.
 */
export interface McpServerEntry {
  /**
   * Server namespace. Tools arrive as `mcp__<name>__<rawName>`, so this is
   * model-visible and must stay stable once a session has seen it.
   */
  name: string
  /** Whether the manager mounts this server. */
  enabled: boolean
  /** Which transport the entry describes. */
  transport: McpTransport
  /** stdio: executable to run. */
  command: string
  /** stdio: arguments. */
  args: string[]
  /** stdio: extra environment. */
  env: Record<string, string>
  /** streamable-http: endpoint. */
  url: string
  /** streamable-http: extra request headers. */
  headers: Record<string, string>
}

/** Durable MCP section. */
export interface McpSettings {
  /** Configured servers, in display order. */
  servers: McpServerEntry[]
}

/** Durable MCP schema; also the wire envelope the browser scope validates against. */
export const McpSettingsSchema: z<McpSettings> = z.object({
  servers: z.array(z.object({
    name: z.string().default(''),
    enabled: z.boolean().default(true),
    transport: z.union([...MCP_TRANSPORTS]).default('stdio'),
    command: z.string().default(''),
    args: z.array(String).default([]),
    env: z.dict(String).default({}),
    url: z.string().default(''),
    headers: z.dict(String).default({}),
  })).default([]),
})

/** Server names the MCP client plugin accepts (they become tool-name segments). */
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/

/**
 * Whether an entry is complete enough to mount.
 *
 * Checked before mounting rather than at the settings boundary: the document is
 * hand-editable and a half-written entry is a normal intermediate state, not a
 * reason to reject the whole section and lose the rest of the list.
 *
 * @param entry - one configured server.
 * @returns true when the manager can mount it.
 */
export function isMountable(entry: McpServerEntry): boolean {
  if (!entry.enabled || !NAME_PATTERN.test(entry.name)) return false
  return entry.transport === 'stdio' ? entry.command !== '' : entry.url !== ''
}
