/**
 * Optional upstream consultation bridges as preset-scoped MCP servers.
 *
 * `grok-exec` (tools `grok` / `grok-reply`) and `antigravity-exec`
 * (`antigravity` / `antigravity-reply`) wrap the `grok` and `agy` CLIs. They
 * are direct consultation tools, not reviewer routes: they never replace
 * `mcp__codex__codex` or satisfy a skill's acceptance gate
 * (skills/shared-references/reviewer-routing.md). Shipped disabled; enable a
 * row only where the CLI is installed and logged in.
 */

import { fileURLToPath } from 'node:url'
import { hostImport } from './host-require.mjs'

export const name = 'aris-bridge'

const BRIDGES = {
  'grok-exec': 'grok',
  'antigravity-exec': 'antigravity',
}

export async function apply(ctx, config) {
  const bridge = config?.bridge
  const serverName = BRIDGES[bridge]
  if (serverName === undefined) {
    throw new Error(`aris-bridge: config.bridge must be one of ${Object.keys(BRIDGES).join(', ')}`)
  }
  const { bridge: _bridge, ...rest } = config
  const mcpClient = await hostImport('@deepseek-ai/dsh-mcp-client')
  await ctx.plugin(mcpClient, {
    toolCallTimeoutMs: 20 * 60 * 1000,
    ...rest,
    transport: 'stdio',
    serverName,
    command: 'python3',
    args: [fileURLToPath(new URL(`../mcp-servers/${bridge}/server.py`, import.meta.url))],
  })
}
