import { join } from 'node:path'

import { createClawSupervisor } from './claw/index.js'
import { loadConfig } from './config.js'
import type { ClawEngine } from './claw/index.js'
import { loadOrCreateToken } from './fs-util.js'
import { Worktrees } from './git/worktrees.js'
import { DEFAULT_MCP_PORT, startMcpHttp } from './mcp/http.js'
import { gripPaths } from './paths.js'
import { assertNotElevated } from './power/elevation.js'
import { KeepAwake } from './power/keep-awake.js'
import { Quota } from './quota/quota.js'
import { CliQuotaReaders } from './quota/readers.js'
import type { QuotaReaders } from './quota/readers.js'
import { RunManager } from './runs/manager.js'
import { RunStore } from './runs/store.js'
import { tailscaleOwner } from './tailscale.js'
import { DEFAULT_WEB_PORT, startWebHttp } from './web/server.js'

export type DaemonOptions = {
  home?: string
  mcpPort?: number
  webPort?: number
  clawPort?: number
  /** Engines the Claw health gate checks; leave out any not signed in on this machine. */
  engines?: readonly ClawEngine[]
  log?: (line: string) => void
  /** Where quota readings come from; the CLIs on this machine unless a test stands in. */
  quotaReaders?: QuotaReaders
  /** Skip the elevation check and keep-awake. Tests only. */
  testing?: boolean
}

/** Lets more workers run at once than Claw's own default, which Grip never needs to hit. */
const CLAW_MAX_SESSIONS = '64'

/**
 * Grip on the principal machine: keep Claw installed and running, recover runs the last Grip
 * left behind, serve the orchestrator MCP and the web API on loopback, and keep the machine
 * awake while runs work. Runs in the user's logged-on session, never elevated, since agy and
 * Codex cannot reach their logins from a service or SSH session.
 */
export async function startDaemon(options: DaemonOptions = {}) {
  const log = options.log ?? ((line: string) => console.log(`[grip] ${line}`))
  const paths = gripPaths(options.home)
  if (!options.testing) await assertNotElevated()
  const config = await loadConfig(paths.config, options.testing ? {} : { owner: () => tailscaleOwner() })
  if (config.trustedOwner) log(`trusting ${config.trustedOwner}, the Tailscale account this machine is signed in to`)
  const keepAwake = new KeepAwake({ ...(options.testing ? { command: null } : {}), log })
  const store = await RunStore.open(paths.home)
  const quota = await Quota.open({ path: paths.quota, readers: options.quotaReaders ?? new CliQuotaReaders() })

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

  const worktrees = new Worktrees()
  const manager = new RunManager({
    store,
    worktrees,
    claw: client,
    clawReady: () => supervisor.whenReady(),
    onActivityChange: n => {
      log(`${n} run${n === 1 ? '' : 's'} working`)
      keepAwake.set(n)
    },
    onTurnEnded: engine => quota.afterTurn(engine),
    // Restarting Claw takes every engine process it started with it.
    killWorkers: () => supervisor.restart(),
  })

  await supervisor.start()
  const recovered = await manager.recover()
  if (recovered.length) log(`marked ${recovered.length} interrupted run(s) as failed`)

  const mcpToken = await loadOrCreateToken(join(paths.home, 'mcp-token'))
  const mcp = await startMcpHttp({ manager, quota, token: mcpToken, port: options.mcpPort ?? DEFAULT_MCP_PORT })
  log(`orchestrator MCP on http://127.0.0.1:${mcp.port}/mcp`)
  const web = await startWebHttp({
    manager,
    store,
    quota,
    worktrees,
    claw: supervisor,
    allowedLogins: config.allowedLogins,
    keepAwake: () => ({ supported: keepAwake.supported, holding: keepAwake.holding }),
    port: options.webPort ?? DEFAULT_WEB_PORT,
  })
  log(`web API on http://127.0.0.1:${web.port} (publish it with tailscale serve)`)
  if (config.allowedLogins.length === 0)
    log(`Tailscale isn't signed in here, so no device can use the web app yet. Sign in to Tailscale and restart Grip.`)
  // The free reads, so the first quota call has something to show.
  void quota.refresh().then(s => log(`quota: ${s.verdict.text}`))

  let stopping: Promise<void> | null = null
  const stop = () =>
    (stopping ??= (async () => {
      log('stopping')
      await Promise.all([mcp.close(), web.close()])
      // Claw stops next with its whole process tree, so there is no need to kill workers here.
      await manager.stopAll({ kill: false })
      await supervisor.stop()
      keepAwake.release()
    })())

  return { manager, store, quota, supervisor, mcpPort: mcp.port, webPort: web.port, stop }
}
