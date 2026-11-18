import { join } from 'node:path'

import { createClawSupervisor } from './claw/index.js'
import type { ClawEngine } from './claw/index.js'
import { loadOrCreateToken } from './fs-util.js'
import { Worktrees } from './git/worktrees.js'
import { DEFAULT_MCP_PORT, startMcpHttp } from './mcp/http.js'
import { gripPaths } from './paths.js'
import { RunManager } from './runs/manager.js'
import { RunStore } from './runs/store.js'

export type DaemonOptions = {
  home?: string
  mcpPort?: number
  clawPort?: number
  /** Engines the Claw health gate checks; leave out any not signed in on this machine. */
  engines?: readonly ClawEngine[]
  log?: (line: string) => void
}

/** Lets more workers run at once than Claw's own default, which Grip never needs to hit. */
const CLAW_MAX_SESSIONS = '64'

/**
 * Grip on the principal machine: keep Claw installed and running, recover runs the last Grip
 * left behind, and serve the orchestrator MCP on loopback. Runs in the user's logged-on session,
 * since agy and Codex cannot reach their logins from a service or SSH session.
 */
export async function startDaemon(options: DaemonOptions = {}) {
  const log = options.log ?? ((line: string) => console.log(`[grip] ${line}`))
  const paths = gripPaths(options.home)
  const store = await RunStore.open(paths.home)

  const { supervisor, client } = await createClawSupervisor({
    ...(options.home ? { home: options.home } : {}),
    ...(options.clawPort ? { port: options.clawPort } : {}),
    ...(options.engines ? { engines: options.engines } : {}),
    env: { OPENCLAW_SERVE_MAX_SESSIONS: CLAW_MAX_SESSIONS },
    isIdle: async () => store.running().length === 0,
  })
  supervisor.on('status', s => log(`claw ${s}${supervisor.version ? ` (${supervisor.version})` : ''}`))
  supervisor.on('rolled-back', e => log(`claw ${e.attempted} failed checks (${e.reason}); back on ${e.to}`))
  supervisor.on('major-available', v => log(`claw ${v} is a new major version; it waits for your approval`))
  supervisor.on('error', e => log(`claw update check failed: ${e.message}`))

  const manager = new RunManager({
    store,
    worktrees: new Worktrees(),
    claw: client,
    clawReady: () => supervisor.whenReady(),
    onActivityChange: n => log(`${n} run${n === 1 ? '' : 's'} working`),
  })

  await supervisor.start()
  const recovered = await manager.recover()
  if (recovered.length) log(`marked ${recovered.length} interrupted run(s) as failed`)

  const mcpToken = await loadOrCreateToken(join(paths.home, 'mcp-token'))
  const mcp = await startMcpHttp({ manager, token: mcpToken, port: options.mcpPort ?? DEFAULT_MCP_PORT })
  log(`orchestrator MCP on http://127.0.0.1:${mcp.port}/mcp`)

  let stopping: Promise<void> | null = null
  const stop = () =>
    (stopping ??= (async () => {
      log('stopping')
      await mcp.close()
      await manager.stopAll()
      await supervisor.stop()
    })())

  return { manager, store, supervisor, mcpPort: mcp.port, stop }
}
