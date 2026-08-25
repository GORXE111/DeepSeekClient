/**
 * MCP card slot store: a mirror of the durable server list. The plugin's
 * apply-world subscription is the only writer; the card reads via props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { McpServerEntry } from '../mcp-settings.ts'

/** Store state mirrored from the durable section. */
export interface McpCardState {
  /** Configured servers, in document order. */
  servers: McpServerEntry[]
  /** Whether this deployment accepts settings writes. */
  writable: boolean
  /** Section revision; -1 until the first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type McpCardActions = {
  sync: (draft: McpCardState, servers: McpServerEntry[], writable: boolean, revision: number) => void
}

/**
 * Declares the MCP card state and write surface.
 * @returns the store handle.
 */
export function createMcpCardStore(): EngineStoreHandle<McpCardState, McpCardActions> {
  return defineStore({
    init: (): McpCardState => ({ servers: [], writable: false, revision: -1 }),
    actions: {
      sync: (d, servers: McpServerEntry[], writable: boolean, revision: number) => {
        // The revision guard drops stale duplicates, but a local edit republishes
        // at the same revision until the Host accepts it — so writability and the
        // list itself are adopted whenever either actually differs.
        if (revision < d.revision) return
        d.servers = servers
        d.writable = writable
        d.revision = revision
      },
    },
  })
}
