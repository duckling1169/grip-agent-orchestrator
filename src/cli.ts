#!/usr/bin/env node
import { join } from 'node:path'

import type { ClawEngine } from './claw/index.js'
import { startDaemon } from './daemon.js'
import { loadOrCreateToken } from './fs-util.js'
import { DEFAULT_MCP_PORT } from './mcp/http.js'
import { gripPaths } from './paths.js'

const USAGE = `grip <command>

  serve [--engines claude,codex-app,agy]   Run Grip: Claw supervisor and the orchestrator MCP
  mcp-config                               Print how to add Grip's MCP server to an orchestrator
`

async function main(argv: string[]) {
  const [command, ...rest] = argv
  if (command === 'serve') {
    const at = rest.indexOf('--engines')
    const engines = at >= 0 ? (rest[at + 1]?.split(',') as ClawEngine[] | undefined) : undefined
    const daemon = await startDaemon(engines ? { engines } : {})
    const shutdown = () => {
      daemon.stop().then(
        () => process.exit(0),
        () => process.exit(1),
      )
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    return
  }

  if (command === 'mcp-config') {
    const token = await loadOrCreateToken(join(gripPaths().home, 'mcp-token'))
    const url = `http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`
    console.log(`Claude Code:\n  claude mcp add --transport http --scope user grip ${url} --header "Authorization: Bearer ${token}"\n`)
    console.log(
      `Any MCP host (Streamable HTTP):\n${JSON.stringify({ mcpServers: { grip: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)}`,
    )
    return
  }

  process.stdout.write(USAGE)
  process.exitCode = command ? 1 : 0
}

main(process.argv.slice(2)).catch(error => {
  console.error(`grip: ${(error as Error).message}`)
  process.exit(1)
})
