import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { ClawEngine, ClawSendResult, ClawSession, StartSessionOptions } from '../claw/client.js'
import { overlappingFiles } from '../git/worktrees.js'
import type { GitFacts, Worktrees, WorktreeDiff } from '../git/worktrees.js'
import { resolveBrief } from './briefs.js'
import { protectedFolderOf } from './protected.js'
import type { Engine, Reader, Run, RunStatus, RunStore } from './store.js'
import { DEFAULT_SETTINGS, minutes } from '../settings.js'

/** The part of Claw's API runs need; the tests stand a fake in for it. */
export interface ClawApi {
  startSession(options: StartSessionOptions): Promise<ClawSession>
  sendMessage(name: string, message: string, options: { timeoutMs: number; effort?: string }): Promise<ClawSendResult>
  stopSession(name: string): Promise<void>
  listSessions(): Promise<ClawSession[]>
}

export const CLAW_ENGINE: Record<Engine, ClawEngine> = { claude: 'claude', codex: 'codex-app', agy: 'agy' }

/**
 * How each engine runs unattended (DESIGN §9.2). Nobody can answer a permission prompt, so a mode
 * that asks would refuse every shell command. Claude and agy use their auto modes, where the
 * engine's own reviewer approves commands; Codex already runs in its `workspace-write` sandbox
 * with no approval prompts. Without this, Claw's default `acceptEdits` blocks git, npm and tests.
 */
export const PERMISSION_MODE: Record<Engine, 'auto' | undefined> = { claude: 'auto', codex: undefined, agy: 'auto' }

/**
 * Grip's MCP server as an orchestrator's config names it. Claude workers start with its tools
 * denied, so a worker that loads Grip from your user config still can't delegate: only chats do.
 */
export const GRIP_MCP_NAME = 'grip'
export const GRIP_TOOLS = `mcp__${GRIP_MCP_NAME}`

export type DelegateInput = {
  folder: string
  engine: Engine
  brief: { path?: string; text?: string }
  model?: string
  effort?: string
  /** A run this one retries from scratch, on any engine. */
  retryOf?: string
  /** The chat delegating it (design §5.1). */
  chatId?: string
}

export type RunDetails = {
  run: Run
  turns: { turn: number; message: string | null; output: string | null }[]
  facts: GitFacts | null
  diff: (WorktreeDiff & { truncated: boolean }) | null
  /** Files this run and another active run in the same repo have both changed. */
  overlaps: { runId: string; title: string; files: string[] }[]
}

export type RunManagerOptions = {
  store: RunStore
  worktrees: Worktrees
  claw: ClawApi
  /** How long one turn may take before Claw ends it. */
  turnTimeoutMs?: number
  /** Called whenever a run starts or ends work, so keep-awake and the supervisor can follow. */
  onActivityChange?: (running: number) => void
  /** Called after each turn ends, however it ended, so quota can be read again. */
  onTurnEnded?: (engine: Engine) => void
  /**
   * Kills every worker at once, for Stop all when Claw does not stop a session in time. The
   * daemon restarts Claw, which takes every engine process it started with it.
   */
  killWorkers?: () => Promise<void>
  /** Waits until Claw can take a turn, for turns that arrive while it starts or updates. */
  clawReady?: () => Promise<void>
}

const DEFAULT_TURN_TIMEOUT_MS = minutes(DEFAULT_SETTINGS.turnTimeoutMinutes)
/** How long Stop all gives Claw to stop each session before it kills every worker. */
const STOP_ALL_GRACE_MS = 5000
const MAX_PATCH_CHARS = 200_000

/**
 * Runs from delegation to result. Each run gets its own worktree when its folder is a git repo,
 * its own Claw session for each turn, and a record in the run store. A Claw session lives only
 * for the length of a turn: idle runs hold no session slot and never hit Claw's idle expiry, and
 * the next message resumes the engine's own conversation.
 */
export class RunManager {
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly stopping = new Set<string>()

  constructor(private readonly options: RunManagerOptions) {}

  private get store() {
    return this.options.store
  }

  /**
   * After Grip starts: fail runs the last Grip left running, and close any Claw sessions they
   * still hold.
   */
  async recover(reason = 'grip restarted'): Promise<Run[]> {
    const stuck = await this.store.interruptRunning(reason)
    const sessions = await this.options.claw.listSessions().catch(() => [])
    for (const s of sessions) if (s.name.startsWith('grip-r-')) await this.options.claw.stopSession(s.name).catch(() => undefined)
    return stuck
  }

  async delegate(input: DelegateInput): Promise<Run> {
    const folder = await realpath(resolve(input.folder)).catch(() => {
      throw new Error(`folder not found: ${input.folder}`)
    })
    if (!(await stat(folder)).isDirectory()) throw new Error(`not a folder: ${input.folder}`)
    const guarded = protectedFolderOf(folder)
    if (guarded) throw new Error(`refusing to run a worker in ${folder}: it is inside protected folder ${guarded}`)
    if (input.retryOf && !this.store.get(input.retryOf)) throw new Error(`unknown run ${input.retryOf}`)

    const brief = await resolveBrief(input.brief, folder)
    const repo = await this.options.worktrees.repoOf(folder)
    let cwd = folder
    let runRepo: Run['repo'] = null
    if (repo) {
      const made = await this.options.worktrees.create(repo, input.engine, brief.title)
      cwd = made.path
      runRepo = { root: repo.root, base: made.base, baseCommit: made.baseCommit, worktree: made.path, branch: made.branch }
    }

    const run = await this.store.create({
      title: brief.title,
      engine: input.engine,
      folder,
      cwd,
      repo: runRepo,
      brief: brief.brief,
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.retryOf ? { retryOf: input.retryOf } : {}),
      ...(input.chatId ? { chatId: input.chatId } : {}),
    })
    return this.beginTurn(run, brief.message)
  }

  /**
   * A follow-up for a run that has finished a turn; it resumes the same conversation. `fromUser`
   * marks a message you sent from the app, so the run's chat sees it came from you.
   */
  async message(id: string, text: string, options: { fromUser?: boolean } = {}): Promise<Run> {
    const run = this.mustGet(id)
    if (this.inFlight.has(id) || run.status === 'running') throw new Error(`run ${id} is still working; wait for it or stop it first`)
    if (!text.trim()) throw new Error('message is empty')
    return this.beginTurn(run, text, options.fromUser ?? false)
  }

  /** Stop a run's current turn. Its worktree and history stay. */
  async stop(id: string): Promise<Run> {
    const run = this.mustGet(id)
    if (run.status !== 'running') return run
    this.stopping.add(id)
    await this.options.claw.stopSession(run.session).catch(() => undefined)
    const stopped = await this.store.markStopped(id)
    this.activityChanged()
    return stopped
  }

  /** Delete a run from the app: stop it if it is working, then stop showing it. Its worktree stays. */
  async delete(id: string): Promise<{ deleted: string }> {
    await this.stop(id)
    await this.store.delete(id)
    return { deleted: id }
  }

  rename(id: string, title: string): Promise<Run> {
    this.mustGet(id)
    return this.store.rename(id, title)
  }

  /**
   * Stop every running run. Each is recorded as stopped first, so the record is right even when
   * Claw hangs. Claw then gets a few seconds to stop each session; if any is left, every worker
   * is killed through `killWorkers`.
   */
  async stopAll(options: { graceMs?: number; kill?: boolean } = {}): Promise<{ stopped: Run[]; killed: boolean }> {
    const running = this.store.running()
    if (running.length === 0) return { stopped: [], killed: false }
    const stopped: Run[] = []
    for (const run of running) {
      this.stopping.add(run.id)
      stopped.push(await this.store.markStopped(run.id))
    }
    this.activityChanged()
    const grace = options.graceMs ?? STOP_ALL_GRACE_MS
    const results = await Promise.all(
      running.map(run =>
        withTimeout(this.options.claw.stopSession(run.session), grace).then(
          () => true,
          () => false,
        ),
      ),
    )
    const killed = results.includes(false) && options.kill !== false && !!this.options.killWorkers
    if (killed) await this.options.killWorkers!()
    return { stopped, killed }
  }

  list(filter: { status?: RunStatus; folder?: string; chatId?: string | null } = {}): Run[] {
    return this.store.list(filter)
  }

  /**
   * Everything known about a run. `markViewed` marks it read by whoever is reading: its
   * orchestrator (`true` or `'orchestrator'`) or you in the app (`'app'`).
   */
  async details(id: string, options: { diff?: boolean; markViewed?: boolean | Reader } = {}): Promise<RunDetails> {
    let run = this.mustGet(id)
    const reader: Reader | null = options.markViewed === true ? 'orchestrator' : options.markViewed || null
    if (reader && run.status !== 'running') run = await this.store.markViewed(id, reader)
    const turns = []
    for (let n = 1; n <= run.turns; n++) turns.push({ turn: n, ...(await this.store.turn(id, n)) })
    let facts: GitFacts | null = null
    let diff: RunDetails['diff'] = null
    if (run.repo) {
      facts = await this.options.worktrees.facts(run.repo.worktree, run.repo.baseCommit).catch(() => null)
      if (options.diff) {
        const d = await this.options.worktrees.diff(run.repo.worktree, run.repo.baseCommit).catch(() => null)
        if (d) {
          const truncated = d.patch.length > MAX_PATCH_CHARS
          diff = { ...d, patch: truncated ? `${d.patch.slice(0, MAX_PATCH_CHARS)}\n… diff truncated …\n` : d.patch, truncated }
        }
      }
    }
    return { run, turns, facts, diff, overlaps: facts ? await this.overlaps(run, facts.changedFiles) : [] }
  }

  /** The next finished run nobody has read, with its result; null if none lands in time. */
  async waitAny(options: { timeoutMs: number; ids?: string[]; chatId?: string | null; signal?: AbortSignal }): Promise<RunDetails | null> {
    const run = await this.store.waitAny(options)
    return run ? this.details(run.id, { diff: true, markViewed: true }) : null
  }

  /** Resolves once the run's current turn has been recorded. For tests and shutdown. */
  async settled(id: string): Promise<void> {
    await this.inFlight.get(id)
  }

  private mustGet(id: string): Run {
    const run = this.store.get(id)
    if (!run) throw new Error(`unknown run ${id}`)
    return run
  }

  private activityChanged(): void {
    this.options.onActivityChange?.(this.store.running().length)
  }

  private async overlaps(run: Run, files: string[]): Promise<RunDetails['overlaps']> {
    if (!run.repo || files.length === 0) return []
    const out: RunDetails['overlaps'] = []
    for (const other of this.store.running()) {
      if (other.id === run.id || other.repo?.root !== run.repo.root) continue
      const theirs = await this.options.worktrees.facts(other.repo.worktree, other.repo.baseCommit).catch(() => null)
      const both = theirs ? overlappingFiles(files, theirs.changedFiles) : []
      if (both.length) out.push({ runId: other.id, title: other.title, files: both })
    }
    return out
  }

  /** Record the turn, then run it in the background; the caller gets the run at once. */
  private async beginTurn(run: Run, message: string, fromUser = false): Promise<Run> {
    const turn = await this.store.startTurn(run.id, message, { fromUser })
    this.stopping.delete(run.id)
    const work = this.runTurn(run, turn, message).finally(() => {
      this.inFlight.delete(run.id)
      this.activityChanged()
      this.options.onTurnEnded?.(run.engine)
    })
    this.inFlight.set(run.id, work)
    this.activityChanged()
    return this.mustGet(run.id)
  }

  private async runTurn(run: Run, turn: number, message: string): Promise<void> {
    const claw = this.options.claw
    let result: { output: string; error: string | null; sessionId: string | null }
    try {
      await this.options.clawReady?.()
      await claw.startSession({
        name: run.session,
        cwd: run.cwd,
        engine: CLAW_ENGINE[run.engine],
        ...(PERMISSION_MODE[run.engine] ? { permissionMode: PERMISSION_MODE[run.engine] } : {}),
        ...(run.model ? { model: run.model } : {}),
        ...(run.effort ? { effort: run.effort } : {}),
        ...(run.engineSessionId ? { resumeSessionId: run.engineSessionId } : {}),
        ...(run.engine === 'claude' ? { disallowedTools: [GRIP_TOOLS] } : {}),
      })
      // A stop that landed while the session was starting must not let the turn begin.
      if (this.stopping.has(run.id)) throw new Error('stopped before the turn began')
      const sent = await claw.sendMessage(run.session, message, {
        timeoutMs: this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
        ...(run.effort ? { effort: run.effort } : {}),
      })
      const denied = sent.permissionDenials?.length
        ? `\n\n[grip] ${sent.permissionDenials.length} tool call(s) were denied: ${sent.permissionDenials.map(d => d.toolName).join(', ')}`
        : ''
      result = { output: `${sent.output}${denied}`, error: sent.error ?? null, sessionId: sent.sessionId ?? null }
    } catch (error) {
      result = { output: '', error: (error as Error).message, sessionId: null }
    } finally {
      await claw.stopSession(run.session).catch(() => undefined)
    }

    if (this.stopping.has(run.id)) {
      // Stopped by hand: keep whatever came back, but the run stays stopped.
      await this.store.saveOutput(run.id, turn, result.output)
      return
    }
    await this.store.endTurn(run.id, turn, result)
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)
    work.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error as Error)
      },
    )
  })
}
