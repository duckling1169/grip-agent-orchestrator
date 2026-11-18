import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { NpmClawPackages } from '../claw/packages.js'
import { CLAW_PACKAGE, CLAW_RANGE, inRange, pickTarget } from '../claw/versions.js'
import { loadConfig } from '../config.js'
import { exec as defaultExec, execOk } from '../exec.js'
import type { Exec } from '../exec.js'
import { loadOrCreateToken } from '../fs-util.js'
import { DEFAULT_MCP_PORT } from '../mcp/http.js'
import { gripPaths } from '../paths.js'
import { assertNotElevated } from '../power/elevation.js'
import { PushNotifier } from '../push/notifier.js'
import { ENGINE_NAMES } from '../runs/store.js'
import type { Engine } from '../runs/store.js'
import { tailscaleOwner } from '../tailscale.js'
import { DEFAULT_STATIC_DIR } from '../web/static.js'
import { DEFAULT_WEB_PORT } from '../web/server.js'
import { LocalApi } from './local-api.js'
import { currentUser, LogonTask, TASK_NAME, taskXml } from './logon-task.js'
import { ensureServe, readServe, serveCommand } from './tailscale-serve.js'
import type { ServeState } from './tailscale-serve.js'

const CODEX_PACKAGE = '@openai/codex'
/** Claw installs and its health gate run before Grip's web port opens on a first start. */
const FIRST_START_MS = 3 * 60 * 1000

export type CommandContext = {
  home: string
  /** Set when Grip's home came from GRIP_HOME, so the logon task uses the same one. */
  customHome: boolean
  /** The compiled `cli.js` this command runs from, which the logon task will start. */
  cli: string
  out?: (line: string) => void
  run?: Exec
}

/** How to add Grip to an orchestrator, and what to take out (design §15). */
export function mcpConfigText(token: string): string {
  const url = `http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`
  return [
    `Claude Code:`,
    `  claude mcp add --transport http --scope user grip ${url} --header "Authorization: Bearer ${token}"`,
    ``,
    `Any MCP host (Streamable HTTP):`,
    JSON.stringify({ mcpServers: { grip: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
  ].join('\n')
}

const SWITCH_OVER = [
  `Then switch the orchestrator over to Grip:`,
  `  - Add Grip only to the orchestrator's host (Claude Code), never to Codex's or agy's own config.`,
  `  - Remove clawo-mcp from it: Grip runs Claw, and clawo-mcp would start sessions Grip can't see.`,
  `  - Stop delegating through codex-plugin-cc and the agy connector.`,
  `  - Turn off alethe's auto-delegation.`,
]

const serveLine = (state: ServeState, changed: boolean) => {
  switch (state.kind) {
    case 'grip':
      return changed ? `published Grip on your tailnet with tailscale serve` : `tailscale serve already publishes Grip`
    case 'other':
      return `tailscale serve already sends this machine's HTTPS root to ${state.target}, so it was left alone. To publish Grip there instead, change it yourself: ${serveCommand(DEFAULT_WEB_PORT)}`
    case 'none':
      return `tailscale serve does not publish Grip yet: ${serveCommand(DEFAULT_WEB_PORT)}`
    case 'unavailable':
      return `could not set up tailscale serve (${state.reason}). Once Tailscale runs, publish Grip with: ${serveCommand(DEFAULT_WEB_PORT)}`
  }
}

/**
 * `grip install` (design §15): what Grip needs on this machine, a logon task that runs it while
 * you are logged on, and how to point an orchestrator at it. Safe to run again.
 */
export async function install(context: CommandContext): Promise<void> {
  const out = context.out ?? (line => console.log(line))
  const run = context.run ?? defaultExec
  if (process.platform !== 'win32') throw new Error('grip install sets Grip up on Windows only for now. On macOS, run grip serve yourself.')
  await assertNotElevated()
  if (!context.cli.endsWith('.js')) throw new Error('Run install from the built CLI: npm run build, then node dist/src/cli.js install.')
  if (!existsSync(join(DEFAULT_STATIC_DIR, 'index.html'))) out(`! the web app isn't built (${DEFAULT_STATIC_DIR}); run npm run build`)

  const root = (await execOk(run, 'npm', ['root', '-g'], 30_000)).trim()
  if (existsSync(join(root, ...CODEX_PACKAGE.split('/'), 'package.json'))) out(`Codex CLI is installed`)
  else {
    out(`installing the Codex CLI (${CODEX_PACKAGE})…`)
    await execOk(run, 'npm', ['install', '-g', CODEX_PACKAGE, '--no-fund', '--no-audit'], 5 * 60 * 1000)
    out(`installed the Codex CLI; sign in once with: codex login`)
  }

  const packages = new NpmClawPackages(run)
  const claw = await packages.installed()
  if (inRange(claw)) out(`Claw ${claw} is installed`)
  else {
    const target = pickTarget(await packages.available())
    if (!target) throw new Error(`no ${CLAW_PACKAGE} release satisfies ${CLAW_RANGE}`)
    out(`installing Claw ${target}…`)
    await packages.install(target)
    out(`installed Claw ${target}`)
  }

  const paths = gripPaths(context.home)
  const config = await loadConfig(paths.config, { owner: () => tailscaleOwner(run) })
  out(
    config.allowedLogins.length
      ? `devices signed in as ${config.allowedLogins.join(', ')} can use Grip`
      : `! Tailscale isn't signed in, so no device can use Grip yet; sign in and run grip install again`,
  )
  const token = await loadOrCreateToken(join(paths.home, 'mcp-token'))
  await PushNotifier.open({ path: paths.push, allowedLogins: config.allowedLogins })
  out(`keys are in ${paths.home}`)

  const serve = await ensureServe(DEFAULT_WEB_PORT, run)
  out(serveLine(serve.state, serve.changed))

  const task = new LogonTask(run)
  const args = ['serve', ...(context.customHome ? ['--home', paths.home] : [])]
  await task.register(taskXml({ node: process.execPath, cli: context.cli, args, cwd: paths.home }, currentUser()))
  out(`registered the "${TASK_NAME}" logon task: Grip starts when you log on, with no window, and logs to ${join(paths.logs, 'grip.log')}`)

  const api = new LocalApi(paths.home)
  if (await api.running()) {
    out(`Grip is already running, probably in a terminal, so the task waits for your next logon.`)
    out(`To move it to the task now, stop that Grip when no runs are working, then run: schtasks /Run /TN ${TASK_NAME}`)
  } else {
    await task.start()
    out(`starting Grip…`)
    out(
      (await api.waitUntilRunning(FIRST_START_MS)) ? `Grip is running` : `! Grip has not answered yet; see ${join(paths.logs, 'grip.log')}`,
    )
  }

  out(``)
  out(mcpConfigText(token))
  out(``)
  for (const line of SWITCH_OVER) out(line)
}

/** `grip uninstall`: stop Grip's logon task and remove it. Grip's home, Claw and tailscale serve stay. */
export async function uninstall(context: CommandContext): Promise<void> {
  const out = context.out ?? (line => console.log(line))
  const task = new LogonTask(context.run ?? defaultExec)
  if (!(await task.definition())) {
    out(`there is no "${TASK_NAME}" logon task`)
    return
  }
  await task.end()
  await task.remove()
  out(`removed the "${TASK_NAME}" logon task`)
  out(`kept ${context.home}, Claw and tailscale serve; remove them yourself if you no longer want them`)
  if (await new LocalApi(context.home).running()) out(`a Grip still answers on this machine, probably one you started in a terminal`)
}

type Summary = { title: string; engine: string; status: string; createdAt: string }
type State = {
  claw: { status: string; version: string | null }
  keepAwake: { supported: boolean; holding: boolean }
  chats: (Summary & { runs: Summary[] })[]
  runs: Summary[]
}

/** What `grip status` prints about a running Grip. */
export function statusLines(state: State, now = Date.now()): string[] {
  const age = (iso: string) => {
    const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  }
  const line = (s: Summary) => `  ${s.title} (${ENGINE_NAMES[s.engine as Engine] ?? s.engine}, ${age(s.createdAt)})`
  const workingChats = state.chats.filter(c => c.status === 'working')
  const workingRuns = [...state.runs, ...state.chats.flatMap(c => c.runs)].filter(r => r.status === 'running')
  const unique = [...new Map(workingRuns.map(r => [`${r.title}${r.createdAt}`, r])).values()]
  return [
    `Claw       ${state.claw.status}${state.claw.version ? ` (${state.claw.version})` : ''}`,
    `Awake      ${state.keepAwake.supported ? (state.keepAwake.holding ? 'kept awake while runs work' : 'normal sleep settings') : 'not managed here'}`,
    `Working    ${unique.length} worker${unique.length === 1 ? '' : 's'}, ${workingChats.length} chat${workingChats.length === 1 ? '' : 's'}`,
    ...workingChats.map(line),
    ...unique.map(line),
  ]
}

/** `grip status`: Grip, its logon task, Tailscale and Claw, plus what is working now. */
export async function status(context: CommandContext): Promise<void> {
  const out = context.out ?? (line => console.log(line))
  const run = context.run ?? defaultExec
  const api = new LocalApi(context.home)
  const [running, definition, owner] = await Promise.all([api.running(), new LogonTask(run).definition(), tailscaleOwner(run)])
  out(`Grip       ${running ? `running on port ${DEFAULT_WEB_PORT}` : 'not running'}`)
  out(`Logon task ${definition ? 'registered' : 'not registered (run grip install)'}`)
  const serve = await readServe(DEFAULT_WEB_PORT, run)
  out(`Tailscale  ${owner ? `signed in as ${owner}` : 'not signed in'}; ${serveSummary(serve)}`)
  if (!running) return
  for (const line of statusLines(await api.call<State>('/api/state'))) out(line)
}

const serveSummary = (state: ServeState) =>
  ({
    grip: 'tailscale serve publishes Grip',
    none: 'tailscale serve does not publish Grip',
    other: `tailscale serve sends the HTTPS root elsewhere`,
    unavailable: 'tailscale serve status unavailable',
  })[state.kind]

/** `grip stop-all`: the app's Stop all button, from a shell. */
export async function stopAll(context: CommandContext): Promise<void> {
  const out = context.out ?? (line => console.log(line))
  const result = await new LocalApi(context.home).call<{ stopped: unknown[]; stoppedChats: unknown[]; killedWorkers: boolean }>(
    '/api/stop-all',
    'POST',
  )
  out(
    `stopped ${result.stopped.length} worker${result.stopped.length === 1 ? '' : 's'} and ${result.stoppedChats.length} chat${result.stoppedChats.length === 1 ? '' : 's'}${result.killedWorkers ? ', restarting Claw to end the ones that did not stop' : ''}`,
  )
}
