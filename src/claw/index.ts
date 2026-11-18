import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { loadOrCreateToken } from '../fs-util.js'
import { gripPaths } from '../paths.js'
import { ClawClient } from './client.js'
import type { ClawEngine } from './client.js'
import { healthGate } from './gate.js'
import { NpmClawPackages } from './packages.js'
import { ClawProcess } from './process.js'
import { FileClawStateStore } from './state.js'
import { ClawSupervisor } from './supervisor.js'

export { ClawClient, ClawError } from './client.js'
export type { ClawEngine, ClawHealth, ClawSession } from './client.js'
export { ClawSupervisor } from './supervisor.js'
export type { SupervisorStatus, UpdateOutcome } from './supervisor.js'
export { CLAW_RANGE } from './versions.js'

export const DEFAULT_CLAW_PORT = 18796

export type ClawSetupOptions = {
  home?: string
  port?: number
  /** Engines the health gate opens a session on. Leave out any not signed in on this machine. */
  engines?: readonly ClawEngine[]
  env?: NodeJS.ProcessEnv
  isIdle?: () => Promise<boolean>
}

/** The real Claw supervisor: npm for packages, `~/.grip` for state, loopback for the server. */
export async function createClawSupervisor(options: ClawSetupOptions = {}) {
  const paths = gripPaths(options.home)
  const port = options.port ?? DEFAULT_CLAW_PORT
  const token = await loadOrCreateToken(paths.clawToken)
  const client = new ClawClient(`http://127.0.0.1:${port}`, token)
  const packages = new NpmClawPackages()
  const gateCwd = join(paths.home, 'gate')
  await mkdir(gateCwd, { recursive: true })

  const runner = new ClawProcess({
    client,
    cliPath: () => packages.cliPath(),
    port,
    token,
    logFile: paths.clawLog,
    ...(options.env ? { env: options.env } : {}),
  })

  const supervisor = new ClawSupervisor({
    packages,
    runner,
    store: new FileClawStateStore(paths.clawState),
    gate: expectedVersion => healthGate({ client, expectedVersion, engines: options.engines ?? ['claude', 'codex-app', 'agy'], cwd: gateCwd }),
    // Until Grip's run store exists: idle means Claw holds no sessions.
    isIdle: options.isIdle ?? (async () => (await client.listSessions().catch(() => [])).length === 0),
  })

  return { supervisor, client, runner, paths }
}
