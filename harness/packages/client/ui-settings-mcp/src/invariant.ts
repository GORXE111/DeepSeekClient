/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-settings-mcp`.
 * @module @deepseek-ai/dsh-client-ui-settings-mcp/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-settings-mcp'

/** Cordis companion plugin name. */
export const name = 'client-ui-settings-mcp-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the mounted set is derived from the durable section on
 * every change and owns no state of its own, and the MCP client plugin carries
 * the connection and tool-generation invariants for each server it mounts.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
