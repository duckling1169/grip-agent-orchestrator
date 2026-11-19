import { homedir } from 'node:os'

import { Database } from './db/database.js'
import { MOXY_SCHEMA } from './db/schema.js'
import { errorText } from './errors.js'
import { loadOrCreateToken } from './files.js'
import { fileLog } from './log.js'
import type { Log } from './log.js'
import { DEFAULT_MCP_PORT, startMcpServer } from './mcp/server.js'
import { LeaderLoop } from './moxy/loop.js'
import { ConversationStore, workerTurnEnded } from './moxy/store.js'
import { moxyPaths } from './paths.js'
import type { MoxyPaths } from './paths.js'
import { protectedFolders } from './repos/folders.js'
import { Integrator } from './repos/integration.js'
import { Worktrees } from './repos/worktrees.js'
import { ClawClient } from './runtime/claw/client.js'
import { assertSupportedClaw, installedClawCli } from './runtime/claw/install.js'
import { ClawProcess } from './runtime/claw/process.js'
import { isEngineInstalled } from './runtime/engines.js'
import { ClawLeader, LEADER_SESSION } from './runtime/leaders/claw-leader.js'
import { leaderRunners } from './runtime/leaders/runners.js'
import type { LeaderRunners } from './runtime/leaders/runners.js'
import { Tasks } from './tasks/service.js'
import { TaskStore } from './tasks/store.js'
import { MOXY_VERSION } from './version.js'
import { DEFAULT_WEB_PORT, startWebServer } from './web/server.js'
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
  log?: Log
}

export type Moxy = {
  paths: MoxyPaths
  database: Database
  workers: Workers
  tasks: Tasks
  conversation: ConversationStore
  loop: LeaderLoop
  clawPort: number
  clawVersion: string
  mcpPort: number
  webPort: number
  stop(): Promise<void>
}

export async function startMoxy(options: MoxyOptions = {}): Promise<Moxy> {
  const paths = moxyPaths(options.home)
  const log = options.log ?? fileLog(paths.moxyLog)
  const database = Database.open(paths.database, MOXY_SCHEMA)
  const undo: (() => Promise<void> | void)[] = [() => database.close()]
  const unwind = async () => {
    for (const step of undo.splice(0).reverse()) await step()
  }
  try {
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
    const { version } = await claw.start()
    undo.push(() => claw.stop())
    assertSupportedClaw(version)
    log(`Claw ${version} on 127.0.0.1:${clawPort}`)

    const conversation = new ConversationStore(database)
    let loop: LeaderLoop | null = null
    const worktrees = new Worktrees()
    const workers = new Workers({
      store: new WorkerStore(database),
      claw: client,
      worktrees,
      protectedFolders: protectedFolders(paths.home),
      isInstalled: isEngineInstalled,
      log,
      onTurnEnded: (worker, turn) => {
        log(`worker ${worker.id} turn ${turn.number} ${turn.status}`)
        if (conversation.receive(workerTurnEnded(worker, turn))) loop?.wake()
      },
    })
    undo.push(() => workers.idle())
    const tasks = new Tasks({ store: new TaskStore(database), workers, worktrees, integrator: new Integrator() })

    const mcpToken = await loadOrCreateToken(paths.mcpToken)
    const mcp = await startMcpServer({
      tools: { workers, tasks, conversation },
      token: mcpToken,
      port: options.mcpPort ?? DEFAULT_MCP_PORT,
      version: MOXY_VERSION,
    })
    undo.push(() => mcp.close())

    const interruptedLeader = conversation.interruptRunningTurn('Moxy restarted during this turn')
    if (interruptedLeader) log(`marked leader turn ${interruptedLeader.id} interrupted; its messages will be delivered again`)
    await client.stopSession(LEADER_SESSION).catch(() => undefined)
    for (const integration of tasks.reconcile()) log(`integration of ${integration.branch} into ${integration.repoRoot} was interrupted`)
    const { interruptedTurns, orphanedSessions } = await workers.reconcile()
    if (interruptedTurns.length) log(`marked ${interruptedTurns.length} interrupted worker turn(s)`)
    if (orphanedSessions.length) log(`stopped ${orphanedSessions.length} Claw session(s) with no running worker turn`)

    const activeLoop = new LeaderLoop({
      conversation,
      runners: options.leaders ?? leaderRunners(new ClawLeader(client, paths.leaderMcpConfig)),
      mcp: { url: `http://127.0.0.1:${mcp.port}/mcp`, token: mcpToken },
      cwd: options.workspace ?? homedir(),
      timeoutMs: options.leaderTimeoutMs ?? LEADER_TURN_TIMEOUT_MS,
      log,
      onTurnEnded: turn => log(`leader turn ${turn.id} ${turn.status}${turn.error ? `: ${turn.error}` : ''}`),
    })
    loop = activeLoop
    undo.push(() => activeLoop.close())

    const web = await startWebServer({
      conversation,
      wake: () => activeLoop.wake(),
      token: await loadOrCreateToken(paths.webToken),
      port: options.webPort ?? DEFAULT_WEB_PORT,
    })
    undo.push(() => web.close())
    log(`Moxy on 127.0.0.1:${web.port}, MCP on 127.0.0.1:${mcp.port}`)
    activeLoop.wake()

    let stopping: Promise<void> | null = null
    const stop = () =>
      (stopping ??= (async () => {
        log('stopping')
        await web.close()
        await activeLoop.close()
        workers.interruptAll()
        await mcp.close()
        await claw.stop()
        await workers.idle()
        database.close()
      })())
    return {
      paths,
      database,
      workers,
      tasks,
      conversation,
      loop: activeLoop,
      clawPort,
      clawVersion: version,
      mcpPort: mcp.port,
      webPort: web.port,
      stop,
    }
  } catch (error) {
    await unwind()
    throw error
  }
}
