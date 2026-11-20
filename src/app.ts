import { mkdir } from 'node:fs/promises'
import { hostname } from 'node:os'

import { loadConfig } from './config.js'
import { Database } from './db/database.js'
import { MOXY_SCHEMA } from './db/schema.js'
import { errorText } from './errors.js'
import { loadOrCreateToken } from './files.js'
import { fileLog } from './log.js'
import type { Log } from './log.js'
import { DEFAULT_MCP_PORT, startMcpServer } from './mcp/server.js'
import { LeaderLoop } from './moxy/loop.js'
import { ConversationStore } from './moxy/store.js'
import { FollowUps } from './moxy/follow-ups.js'
import { ConversationHistory } from './moxy/history.js'
import { Memory } from './moxy/memory.js'
import { ProjectNotes } from './moxy/notes.js'
import { handoffContext } from './moxy/context.js'
import { leaderPrompt } from './moxy/leader-prompt.js'
import { knownRepos } from './repos/known.js'
import type { Engine } from './contracts/engines.js'
import { moxyPaths } from './paths.js'
import { KeepAwake } from './platform/keep-awake.js'
import { tailscaleOwner } from './platform/tailscale.js'
import { PushNotifier } from './platform/push.js'
import type { PushSender } from './platform/push.js'
import type { MoxyPaths } from './paths.js'
import { ModelCatalog } from './providers/models.js'
import { Quota } from './providers/quota.js'
import { CliQuotaReaders } from './providers/quota-readers.js'
import type { QuotaReaders } from './providers/quota-readers.js'
import { Settings } from './settings.js'
import { protectedFolders } from './repos/folders.js'
import { Integrator } from './repos/integration.js'
import { Worktrees } from './repos/worktrees.js'
import { ClawClient } from './runtime/claw/client.js'
import { assertSupportedClaw, installedClawCli } from './runtime/claw/install.js'
import { ClawProcess } from './runtime/claw/process.js'
import { isEngineInstalled } from './runtime/engines.js'
import { ClawLeader, LEADER_SESSION_PREFIX } from './runtime/leaders/claw-leader.js'
import { canRunLeader, leaderRunners } from './runtime/leaders/runners.js'
import type { LeaderRunners } from './runtime/leaders/runners.js'
import { Tasks } from './tasks/service.js'
import { TaskStore } from './tasks/store.js'
import { MOXY_VERSION } from './version.js'
import { DEFAULT_WEB_PORT, startWebServer } from './web/server.js'
import { DEFAULT_STATIC_DIR } from './web/static.js'
import { Workers } from './workers/service.js'
import { WorkerStore } from './workers/store.js'

export const DEFAULT_CLAW_PORT = 18796
const CLAW_MAX_SESSIONS = '64'
const LEADER_TURN_TIMEOUT_MS = 60 * 60_000

export type MoxyOptions = {
  home?: string
  clawPort?: number
  mcpPort?: number
  webPort?: number
  clawCli?: string
  workspace?: string
  leaders?: LeaderRunners
  leaderTimeoutMs?: number
  tailscaleOwner?: () => Promise<string | null>
  staticDir?: string
  log?: Log
  quotaReaders?: QuotaReaders
  models?: Pick<ModelCatalog, 'get'>
  pushSender?: PushSender
  leaderAvailable?: (engine: Engine) => boolean
  keepAwake?: Pick<KeepAwake, 'set' | 'release'>
}

export type Moxy = {
  paths: MoxyPaths
  database: Database
  workers: Workers
  tasks: Tasks
  conversation: ConversationStore
  loop: LeaderLoop
  quota: Quota
  push: PushNotifier
  followUps: FollowUps
  memory: Memory
  notes: ProjectNotes
  history: ConversationHistory
  clawPort: number
  clawVersion: string
  mcpPort: number
  webPort: number
  stop(): Promise<void>
  stopped: Promise<void>
}

export async function startMoxy(options: MoxyOptions = {}): Promise<Moxy> {
  const paths = moxyPaths(options.home)
  const log = options.log ?? fileLog(paths.moxyLog)
  const config = await loadConfig(paths.config, options.tailscaleOwner ?? (() => tailscaleOwner()))
  const database = Database.open(paths.database, MOXY_SCHEMA)
  const undo: (() => Promise<void> | void)[] = [() => database.close()]
  const unwind = async () => {
    for (const step of undo.splice(0).reverse()) await step()
  }
  try {
    const push = await PushNotifier.open({ path: paths.push, allowedLogins: () => config.allowedLogins, sender: options.pushSender })
    undo.push(() => push.close())
    const quota = await Quota.open({ path: paths.quota, readers: options.quotaReaders ?? new CliQuotaReaders() })
    undo.push(() => quota.close())
    const settings = new Settings(paths.config, { quotaRefreshMinutes: config.quotaRefreshMinutes })
    const models = options.models ?? new ModelCatalog()
    settings.on('change', value => quota.startTimer(value.quotaRefreshMinutes * 60_000))
    const clawPort = options.clawPort ?? DEFAULT_CLAW_PORT
    const client = new ClawClient(`http://127.0.0.1:${clawPort}`, await loadOrCreateToken(paths.clawToken))
    const claw = new ClawProcess({
      client,
      cliPath: options.clawCli ?? (await installedClawCli()),
      port: clawPort,
      logFile: paths.clawLog,
      env: { OPENCLAW_SERVE_MAX_SESSIONS: CLAW_MAX_SESSIONS },
    })
    claw.on('crashed', ({ code, restartInMs }) => log(`Claw exited with code ${code}; restarting in ${restartInMs / 1000} s`))
    claw.on('restartFailed', error => log(`Claw restart failed: ${errorText(error)}`))
    const stopClaw = () =>
      claw
        .stop()
        .catch(error => log(`Claw stop failed: ${errorText(error)}`))
        .finally(() => client.close())

    const conversation = new ConversationStore(database)
    let loop: LeaderLoop | null = null
    const memory = new Memory(database)
    const history = new ConversationHistory(database)
    const followUps = new FollowUps(database, { wake: () => loop?.wake(), onError: error => log(`follow-up failed: ${errorText(error)}`) })
    undo.push(() => followUps.close())
    const worktrees = new Worktrees()
    const notes = new ProjectNotes(database, worktrees)
    const workers = new Workers({
      store: new WorkerStore(database, conversation),
      claw: client,
      worktrees,
      protectedFolders: protectedFolders(paths.home),
      isInstalled: isEngineInstalled,
      log,
      onTurnEnded: (worker, turn) => {
        quota.afterTurn(worker.engine)
        log(`worker ${worker.id} turn ${turn.number} ${turn.status}`)
        loop?.wake()
      },
    })
    undo.push(() => workers.idle())
    const tasks = new Tasks({
      store: new TaskStore(database),
      workers,
      worktrees,
      integrator: new Integrator(),
      onReady: task => {
        void push
          .ready(task)
          .then(report => {
            if (report.failed) log(`push: ${report.failed} of ${report.attempted} notifications failed`)
          })
          .catch(error => log(`push failed: ${errorText(error)}`))
      },
    })

    undo.push(stopClaw)
    const { version } = await claw.start(async version => {
      assertSupportedClaw(version)
      const interruptedLeader = conversation.interruptRunningTurn('Moxy restarted during this turn')
      if (interruptedLeader) log(`marked leader turn ${interruptedLeader.id} interrupted; its messages will be delivered again`)
      const leaderSessions = (await client.listSessions()).filter(session => session.name.startsWith(LEADER_SESSION_PREFIX))
      await Promise.all(leaderSessions.map(session => client.stopSession(session.name).catch(() => undefined)))
      for (const integration of tasks.reconcile()) log(`integration of ${integration.branch} into ${integration.repoRoot} was interrupted`)
      const { interruptedTurns, orphanedSessions } = await workers.reconcile()
      if (interruptedTurns.length) log(`marked ${interruptedTurns.length} interrupted worker turn(s)`)
      if (orphanedSessions.length) log(`stopped ${orphanedSessions.length} Claw session(s) with no running worker turn`)
    })
    assertSupportedClaw(version)
    log(`Claw ${version} on 127.0.0.1:${clawPort}`)

    const mcpToken = await loadOrCreateToken(paths.mcpToken)
    const mcp = await startMcpServer({
      tools: { workers, tasks, quota, models, followUps, memory, notes, history },
      token: mcpToken,
      port: options.mcpPort ?? DEFAULT_MCP_PORT,
      version: MOXY_VERSION,
    })
    undo.push(() => mcp.close())

    const workspace = options.workspace ?? paths.leaderWorkspace
    await mkdir(workspace, { recursive: true })
    const activeLoop = new LeaderLoop({
      conversation,
      runners: options.leaders ?? leaderRunners(new ClawLeader(client, paths.leaderMcpConfig)),
      mcp: { url: `http://127.0.0.1:${mcp.port}/mcp`, token: mcpToken },
      cwd: workspace,
      systemPrompt: async engine =>
        leaderPrompt({ machine: hostname(), engine, repoFolders: config.repoFolders, repos: await knownRepos(config.repoFolders) }),
      timeoutMs: options.leaderTimeoutMs ?? LEADER_TURN_TIMEOUT_MS,
      log,
      seed: turnId =>
        handoffContext(
          { tasks: tasks.list(), conversation: conversation.conversation(), memory: memory.read(), notes: notes.list() },
          turnId,
        ),
      instructions: () => {
        const instructions = memory.read().instructions
        return instructions ? `[User standing instructions]\n${instructions}` : ''
      },
      quota: () => quota.snapshot(),
      available: options.leaderAvailable ?? canRunLeader,
      onTurnEnded: turn => {
        quota.afterTurn(turn.engine)
        log(`leader turn ${turn.id} ${turn.status}${turn.error ? `: ${turn.error}` : ''}`)
      },
    })
    loop = activeLoop
    undo.push(() => activeLoop.close())

    const web = await startWebServer({
      conversation,
      loop: activeLoop,
      tasks,
      workers,
      database,
      allowedLogins: config.allowedLogins,
      token: await loadOrCreateToken(paths.webToken),
      port: options.webPort ?? DEFAULT_WEB_PORT,
      host: hostname(),
      staticDir: options.staticDir ?? DEFAULT_STATIC_DIR,
      uploadsDir: paths.uploads,
      quota,
      models,
      settings,
      push,
      shutdown: () => void stop().catch(error => log(`stop failed: ${errorText(error)}`)),
    })
    if (config.allowedLogins.length === 0) log(`no Tailscale login is allowed yet; add one to allowedLogins in ${paths.config}`)
    undo.push(() => web.close())
    log(`Moxy on 127.0.0.1:${web.port}, MCP on 127.0.0.1:${mcp.port}`)
    activeLoop.wake()
    followUps.start()
    quota.startTimer(settings.current().quotaRefreshMinutes * 60_000)

    const keepAwake = options.keepAwake ?? new KeepAwake({ log })
    const workRunning = database.prepare(
      `SELECT EXISTS (SELECT 1 FROM worker_turns WHERE status = 'running') OR EXISTS (SELECT 1 FROM leader_turns WHERE status = 'running') AS running`,
    )
    const stopFollowingWork = database.onChange(() => keepAwake.set(Number(workRunning.get()?.running) === 1))

    let markStopped = () => {}
    const stopped = new Promise<void>(resolve => (markStopped = resolve))
    let stopping: Promise<void> | null = null
    const stop = () =>
      (stopping ??= (async () => {
        log('stopping')
        stopFollowingWork()
        keepAwake.release()
        followUps.close()
        const quotaClosed = quota.close()
        const pushClosed = push.close()
        const webClosed = web.close()
        const leaderClosed = activeLoop.close().catch(error => log(`leader stop failed: ${errorText(error)}`))
        workers.interruptAll()
        const mcpClosed = mcp.close()
        await stopClaw()
        await Promise.all([webClosed, leaderClosed, mcpClosed, workers.idle(), quotaClosed, pushClosed])
        database.close()
      })().finally(markStopped))
    return {
      paths,
      database,
      workers,
      tasks,
      conversation,
      loop: activeLoop,
      quota,
      push,
      followUps,
      memory,
      notes,
      history,
      clawPort,
      clawVersion: version,
      mcpPort: mcp.port,
      webPort: web.port,
      stop,
      stopped,
    }
  } catch (error) {
    await unwind()
    throw error
  }
}
