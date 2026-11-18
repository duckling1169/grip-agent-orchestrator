import { realpath, stat } from 'node:fs/promises'
import { errorText } from '../errors.js'
import { resolve } from 'node:path'

import type { ClawEngine, ClawPermissionMode, ClawSendResult, ClawSession, StartSessionOptions } from '../claw/client.js'
import { ENGINE_NAMES, ENGINES, engineSpec } from '../engines.js'
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

/** How many of a repo's newest other runs `result` checks for overlapping changes. */
const OVERLAP_RUNS = 20

export const CLAW_ENGINE = Object.fromEntries(ENGINES.map(engine => [engine, engineSpec(engine).claw])) as Record<Engine, ClawEngine>

/**
 * How each engine runs unattended (DESIGN §9.2). Nobody can answer a permission prompt, so a mode
 * that asks would refuse every shell command. Claude, agy and Grok use their auto modes, where the
 * engine's own reviewer approves commands; Gemini CLI has none, so it skips prompts. Codex already
 * runs in its `workspace-write` sandbox with no approval prompts, Cursor with `--force`, and ACP
 * agents are allowed by Claw. Without this, Claw's default `acceptEdits` blocks git, npm and tests.
 */
export const PERMISSION_MODE = Object.fromEntries(ENGINES.map(engine => [engine, engineSpec(engine).permissionMode])) as Record<
  Engine,
  ClawPermissionMode | undefined
>

/**
 * Grip's MCP server as an orchestrator's config names it. Claude workers start with its tools
 * denied, so a worker that loads Grip from your user config still can't delegate: only chats do.
 */
export const GRIP_MCP_NAME = 'grip'
export const GRIP_TOOLS = `mcp__${GRIP_MCP_NAME}`

/**
 * Workers may use their engine's own subagents, but only ones that finish within the turn: Grip
 * stops the Claw session when the turn ends (see runTurn), so anything left running dies unseen
 * (DESIGN §5.1).
 * Claude is the only engine with a system prompt Grip can add to.
 */
export const WORKER_PROMPT =
  'You are a worker started by Grip. You may use subagents for parts of this task, but wait for each one to ' +
  'finish before you reply. Do not leave subagents or background jobs running when your turn ends: they stop ' +
  'with it, and nobody sees their results.'

export type DelegateInput = {
  /** Required, except for a retry, which defaults to the retried run's folder. */
  folder?: string
  engine: Engine
  /** Required, except for a retry, which defaults to the retried run's brief. */
  brief: { path?: string; text?: string }
  /** Names the run and its branch; otherwise the brief's first line does (a retry keeps the old name). */
  title?: string
  model?: string
  effort?: string
  /** A run this one retries from scratch, on any engine. */
  retryOf?: string
  /** The chat delegating it (design §5.1). */
  chatId?: string
}

export type RunActivity = {
  lastEdit: GitFacts['newestEdit']
  lastCommit: GitFacts['lastCommit']
  changedFiles: number
  commits: number
}

export type RunDetails = {
  run: Run
  turns: { turn: number; message: string | null; output: string | null }[]
  facts: GitFacts | null
  diff: (WorktreeDiff & { truncated: boolean }) | null
  /** Files this run and another active run in the same repo have both changed. */
  /** Other runs in the same repo whose unmerged work touches the same files; `running` when still working. */
  overlaps: { runId: string; title: string; files: string[]; running: boolean }[]
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
  /** Whether an engine's CLI is installed here; a run on one that is not is refused at once. */
  installed?: (engine: Engine) => boolean
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
    const original = input.retryOf ? this.store.get(input.retryOf) : null
    if (input.retryOf && !original) throw new Error(`unknown run ${input.retryOf}`)
    if (this.options.installed && !this.options.installed(input.engine))
      throw new Error(`${ENGINE_NAMES[input.engine]} is not installed on this machine (no ${engineSpec(input.engine).bin} on PATH)`)
    const asked = input.folder ?? original?.folder
    if (!asked) throw new Error('a folder is required')
    const folder = await realpath(resolve(asked)).catch(() => {
      throw new Error(`folder not found: ${asked}`)
    })
    if (!(await stat(folder)).isDirectory()) throw new Error(`not a folder: ${asked}`)
    const guarded = protectedFolderOf(folder)
    if (guarded) throw new Error(`refusing to run a worker in ${folder}: it is inside protected folder ${guarded}`)

    // A retry without a brief redoes the old one.
    const given = input.brief.path || input.brief.text
    const briefInput =
      !given && original ? (original.brief.kind === 'path' ? { path: original.brief.path } : { text: original.brief.text }) : input.brief
    const brief = await resolveBrief(briefInput, folder)
    const title = input.title?.trim() || original?.title || brief.title
    const repo = await this.options.worktrees.repoOf(folder)
    let cwd = folder
    let runRepo: Run['repo'] = null
    if (repo) {
      const made = await this.options.worktrees.create(repo, input.engine, title)
      cwd = made.path
      runRepo = { root: repo.root, base: made.base, baseCommit: made.baseCommit, worktree: made.path, branch: made.branch }
    }

    const run = await this.store.create({
      title,
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
    const started = await this.beginTurn(run, brief.message)
    // The retried run's worktree is no longer needed if it never changed anything.
    if (original && original.status !== 'running') await this.removeIfEmpty(original)
    return started
  }

  /**
   * Signs of life in a run's worktree: its newest edit, how many files changed and commits made.
   * Claw reports nothing during a turn, so this is how an orchestrator tells a working run from a
   * stuck one. Null outside a repo, where unrelated files would mislead.
   */
  async activity(run: Run): Promise<RunActivity | null> {
    if (!run.repo) return null
    const facts = await this.options.worktrees.facts(run.repo.worktree, run.repo.baseCommit).catch(() => null)
    if (!facts) return null
    return {
      lastEdit: facts.newestEdit,
      lastCommit: facts.lastCommit,
      changedFiles: facts.changedFiles.length,
      commits: facts.ahead,
    }
  }

  /**
   * Remove a finished run's worktree and branch when the run changed nothing there: no edits and
   * no commits. A worktree with any work in it is never removed automatically.
   */
  async removeIfEmpty(run: Run): Promise<boolean> {
    if (!run.repo || run.status === 'running') return false
    const facts = await this.options.worktrees.facts(run.repo.worktree, run.repo.baseCommit).catch(() => null)
    if (!facts || facts.ahead > 0 || facts.changedFiles.length > 0) return false
    return this.options.worktrees.remove(run.repo.root, run.repo.worktree, run.repo.base).then(
      () => true,
      () => false,
    )
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

  /** Delete a run from the app: stop it if it is working, then stop showing it. Its worktree stays if it holds any work. */
  async delete(id: string): Promise<{ deleted: string }> {
    await this.stop(id)
    await this.inFlight.get(id)
    await this.removeIfEmpty(this.mustGet(id))
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

  /**
   * Other runs in the same repo that changed any of the same files and are not merged yet:
   * working ones, and finished ones whose worktree still holds work that `base` lacks. Those are
   * the clashes you meet when merging. Only the newest runs are checked, to keep `result` quick.
   */
  private async overlaps(run: Run, files: string[]): Promise<RunDetails['overlaps']> {
    if (!run.repo || files.length === 0) return []
    const root = run.repo.root
    const others = this.store.list().filter(other => other.id !== run.id && other.repo?.root === root)
    const out: RunDetails['overlaps'] = []
    for (const other of others.slice(0, OVERLAP_RUNS)) {
      const repo = other.repo!
      const theirs = await this.options.worktrees.facts(repo.worktree, repo.baseCommit).catch(() => null)
      const both = theirs ? overlappingFiles(files, theirs.changedFiles) : []
      if (!both.length) continue
      const running = other.status === 'running'
      // A removed worktree fails here too, and has nothing left to clash.
      if (!running && (await this.options.worktrees.merged(repo.worktree, repo.base).catch(() => true))) continue
      out.push({ runId: other.id, title: other.title, files: both, running })
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
        ...(engineSpec(run.engine).acpAgent ? { acpAgent: engineSpec(run.engine).acpAgent } : {}),
        ...(PERMISSION_MODE[run.engine] ? { permissionMode: PERMISSION_MODE[run.engine] } : {}),
        ...(run.model ? { model: run.model } : {}),
        ...(run.effort ? { effort: run.effort } : {}),
        ...(run.engineSessionId ? { resumeSessionId: run.engineSessionId } : {}),
        ...(run.engine === 'claude' ? { disallowedTools: [GRIP_TOOLS], appendSystemPrompt: WORKER_PROMPT } : {}),
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
      result = { output: '', error: errorText(error), sessionId: null }
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
