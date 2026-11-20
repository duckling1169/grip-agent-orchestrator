import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import type { Snapshot } from '../contracts/api.js'
import { loadConfig } from '../config.js'
import { exec as defaultExec } from '../exec.js'
import type { Exec } from '../exec.js'
import { loadOrCreateToken } from '../files.js'
import { moxyPaths } from '../paths.js'
import { CLAW_RANGE, installClaw, installedClawVersion, isSupportedClaw } from '../runtime/claw/install.js'
import { MoxyClient } from '../web/client.js'
import { DEFAULT_WEB_PORT } from '../web/server.js'
import { DEFAULT_STATIC_DIR } from '../web/static.js'
import { assertNotElevated } from './elevation.js'
import { currentUser, LogonTask, TASK_NAME, taskXml } from './logon-task.js'
import { ensureServe, readServe, serveCommand, tailscaleOwner } from './tailscale.js'
import type { ServeState } from './tailscale.js'

const FIRST_START_MS = 3 * 60_000
const STOP_MS = 60_000

export type LocalMoxy = Pick<MoxyClient, 'running' | 'waitUntilRunning' | 'state' | 'shutdown'>

export type CommandContext = {
  home: string
  customHome: boolean
  cli: string
  staticDir?: string
  out?: (line: string) => void
  run?: Exec
  platform?: NodeJS.Platform
  moxy?: LocalMoxy
  waitForExit?: (pid: number, limitMs: number) => Promise<boolean>
}

type Command = {
  out: (line: string) => void
  run: Exec
  paths: ReturnType<typeof moxyPaths>
  task: LogonTask
  moxy: () => Promise<LocalMoxy>
  waitForExit: (pid: number, limitMs: number) => Promise<boolean>
}

function command(context: CommandContext): Command {
  const run = context.run ?? defaultExec
  const paths = moxyPaths(context.home)
  return {
    out: context.out ?? (line => console.log(line)),
    run,
    paths,
    task: new LogonTask(run),
    moxy: async () => context.moxy ?? new MoxyClient(`http://127.0.0.1:${DEFAULT_WEB_PORT}`, await loadOrCreateToken(paths.webToken)),
    waitForExit: context.waitForExit ?? waitForExit,
  }
}

export async function install(context: CommandContext): Promise<void> {
  const { out, run, paths, task, moxy } = command(context)
  const platform = context.platform ?? process.platform
  if (platform !== 'win32') throw new Error('moxy install supports Windows only. Elsewhere, run moxy serve yourself.')
  await assertNotElevated(run, platform)
  if (!context.cli.endsWith('.js')) throw new Error('Run install from the built CLI: npm run build, then node dist/cli.js install.')
  const staticDir = context.staticDir ?? DEFAULT_STATIC_DIR
  if (!existsSync(join(staticDir, 'index.html'))) out(`! the web app is not built (${staticDir}); run npm run build`)

  const claw = await installedClawVersion(run)
  if (isSupportedClaw(claw)) out(`Claw ${claw} is installed`)
  else {
    out(claw ? `Claw ${claw} is outside ${CLAW_RANGE}; installing a supported release…` : 'installing Claw…')
    out(`installed Claw ${await installClaw(run)}`)
  }

  await mkdir(paths.home, { recursive: true })
  const config = await loadConfig(paths.config, () => tailscaleOwner(run))
  out(
    config.allowedLogins.length
      ? `devices signed in as ${config.allowedLogins.join(', ')} can use Moxy`
      : '! Tailscale is not signed in, so no device can use Moxy yet; sign in and run moxy install again',
  )

  const serve = await ensureServe(DEFAULT_WEB_PORT, run)
  out(serveLine(serve.state, serve.changed))

  const args = ['serve', ...(context.customHome ? ['--home', paths.home] : [])]
  await task.register(taskXml({ node: process.execPath, cli: context.cli, args, cwd: paths.home }, currentUser()))
  out(`registered the "${TASK_NAME}" logon task: Moxy starts when you log on, with no window, and logs to ${paths.moxyLog}`)

  const local = await moxy()
  if (await local.running()) {
    out('Moxy is already running, so the task waits for your next logon. To move Moxy to the task now, run: moxy restart')
    return
  }
  await task.start()
  out('starting Moxy…')
  out((await local.waitUntilRunning(FIRST_START_MS)) ? 'Moxy is running' : `! Moxy has not answered yet; see ${paths.moxyLog}`)
}

export async function uninstall(context: CommandContext): Promise<void> {
  const { out, task, moxy } = command(context)
  if (!(await task.definition())) {
    out(`there is no "${TASK_NAME}" logon task`)
    return
  }
  await task.end()
  await task.remove()
  out(`removed the "${TASK_NAME}" logon task`)
  out(`kept ${context.home}, Claw and tailscale serve; remove them yourself if you no longer want them`)
  if (await (await moxy()).running()) out('Moxy keeps running until you stop it with moxy stop or log off')
}

export async function stop(context: CommandContext, force = false): Promise<boolean> {
  const { out, paths, moxy, waitForExit } = command(context)
  const local = await moxy()
  if (!(await local.running())) {
    out('Moxy is not running')
    return false
  }
  if (!force) {
    const busy = workingText(await local.state())
    if (busy) throw new Error(`${busy}. Wait for it, stop it in the app, or pass --force.`)
  }
  const { pid } = await local.shutdown()
  out('stopping Moxy…')
  if (!(await waitForExit(pid, STOP_MS)))
    throw new Error(`Moxy (process ${pid}) has not exited after ${STOP_MS / 1000} s; see ${paths.moxyLog}`)
  out('Moxy stopped')
  return true
}

export async function restart(context: CommandContext, force = false): Promise<void> {
  const { task } = command(context)
  if (!(await task.definition())) throw new Error(`there is no "${TASK_NAME}" logon task to start Moxy again; run moxy install`)
  await stop(context, force)
  await startTask(context)
}

export async function upgradeClaw(context: CommandContext, force = false): Promise<void> {
  const { out, run, task } = command(context)
  const before = await installedClawVersion(run)
  const wasRunning = await stop(context, force)
  out(`installing the newest Claw in ${CLAW_RANGE}…`)
  const after = await installClaw(run)
  out(before === after ? `Claw ${after} is already the newest supported release` : `upgraded Claw ${before ?? '(none)'} to ${after}`)
  if (!wasRunning) return
  if (await task.definition()) await startTask(context)
  else out('start Moxy again with moxy serve')
}

export async function status(context: CommandContext): Promise<void> {
  const { out, run, task, moxy } = command(context)
  const local = await moxy()
  const [running, definition, owner, serve, claw] = await Promise.all([
    local.running(),
    task.definition(),
    tailscaleOwner(run),
    readServe(DEFAULT_WEB_PORT, run),
    installedClawVersion(run),
  ])
  out(`Moxy       ${running ? `running on port ${DEFAULT_WEB_PORT}` : 'not running'}`)
  out(`Logon task ${definition ? 'registered' : 'not registered (run moxy install)'}`)
  out(`Tailscale  ${owner ? `signed in as ${owner}` : 'not signed in'}; ${SERVE_SUMMARY[serve.kind]}`)
  out(`Claw       ${claw ? `${claw}${isSupportedClaw(claw) ? '' : ` (Moxy needs ${CLAW_RANGE})`}` : 'not installed'}`)
  if (running) out(`Working    ${workingText(await local.state()) || 'nothing'}`)
}

export function workingText(state: Pick<Snapshot, 'workers' | 'conversation'>): string {
  const workers = state.workers.filter(worker => worker.status === 'running').length
  const leader = state.conversation.some(entry => entry.type === 'moxy' && entry.turn.status === 'running')
  const parts = [
    ...(leader ? ['Moxy is replying'] : []),
    ...(workers ? [`${workers} worker${workers === 1 ? ' is' : 's are'} working`] : []),
  ]
  return parts.join(' and ')
}

async function startTask(context: CommandContext): Promise<void> {
  const { out, paths, task, moxy } = command(context)
  await task.end()
  await task.start()
  out('starting Moxy…')
  out((await (await moxy()).waitUntilRunning(FIRST_START_MS)) ? 'Moxy is running' : `! Moxy has not answered yet; see ${paths.moxyLog}`)
}

const SERVE_SUMMARY: Record<ServeState['kind'], string> = {
  moxy: 'tailscale serve publishes Moxy',
  none: 'tailscale serve does not publish Moxy',
  other: 'tailscale serve sends the HTTPS root elsewhere',
  unavailable: 'tailscale serve status unavailable',
}

function serveLine(state: ServeState, changed: boolean): string {
  switch (state.kind) {
    case 'moxy':
      return changed ? 'published Moxy on your tailnet with tailscale serve' : 'tailscale serve already publishes Moxy'
    case 'other':
      return `tailscale serve already sends this machine's HTTPS root to ${state.target}, so Moxy left it alone. To publish Moxy there instead, change it yourself: ${serveCommand(DEFAULT_WEB_PORT)}`
    case 'none':
      return `tailscale serve does not publish Moxy yet: ${serveCommand(DEFAULT_WEB_PORT)}`
    case 'unavailable':
      return `could not set up tailscale serve (${state.reason}). Once Tailscale runs, publish Moxy with: ${serveCommand(DEFAULT_WEB_PORT)}`
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitForExit(pid: number, limitMs: number): Promise<boolean> {
  const until = Date.now() + limitMs
  while (Date.now() < until) {
    if (!alive(pid)) return true
    await sleep(500)
  }
  return !alive(pid)
}
