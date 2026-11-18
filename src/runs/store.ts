import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { JsonlAppender, readJsonl } from '../jsonl.js'

/** The engines a run can use, as Grip names them. Claw calls Codex's `codex-app`. */
export type Engine = 'claude' | 'codex' | 'agy'
export const ENGINES: readonly Engine[] = ['claude', 'codex', 'agy']

export type RunStatus = 'running' | 'done' | 'failed' | 'stopped'

export type Brief = { kind: 'path'; path: string } | { kind: 'text'; text: string }

export type RunRepo = { root: string; base: string; baseCommit: string; worktree: string; branch: string }

export type Run = {
  id: string
  title: string
  engine: Engine
  model: string | null
  effort: string | null
  /** The folder asked for. */
  folder: string
  /** Where the worker runs: the worktree for a repo, otherwise the folder itself. */
  cwd: string
  repo: RunRepo | null
  brief: Brief
  /** The Claw session this run drives. */
  session: string
  /** The engine's own conversation id, so a later message resumes the same conversation. */
  engineSessionId: string | null
  retryOf: string | null
  /** The chat that delegated this run, or null when it was started from the app (design §5.1). */
  chatId: string | null
  status: RunStatus
  error: string | null
  /** Turns that have started, including a stopped or interrupted attempt. */
  turns: number
  /** Turns whose message you sent yourself from the app, rather than the run's chat. */
  fromUser: number[]
  /** Cleared when the run finishes; set once an orchestrator reads its result. `wait_any` follows this. */
  viewed: boolean
  /** Cleared when the run finishes; set once you open it in the app. The app's "new" mark follows this. */
  seen: boolean
  createdAt: string
  updatedAt: string
  finishedAt: string | null
}

export type NewRun = Pick<Run, 'title' | 'engine' | 'folder' | 'cwd' | 'repo' | 'brief'> &
  Partial<Pick<Run, 'model' | 'effort' | 'retryOf' | 'chatId'>>

/** Who reads a run: its orchestrator (through `result` or `wait_any`) or you, in the app. */
export type Reader = 'orchestrator' | 'app'

/** One line of `runs.jsonl`. The log is the record; run state is rebuilt from it on load. */
/** Model and effort for the next turns; null means the agent's default. */
export type TurnSettings = { model: string | null; effort: string | null }

export type RunEvent =
  | { t: 'created'; at: string; run: Run }
  | { t: 'turn-started'; at: string; id: string; turn: number; fromUser?: true }
  | { t: 'turn-ended'; at: string; id: string; turn: number; error: string | null; sessionId?: string }
  | { t: 'stopped'; at: string; id: string }
  | { t: 'interrupted'; at: string; id: string; reason: string }
  | { t: 'viewed'; at: string; id: string; by?: 'app' }
  | ({ t: 'configured'; at: string; id: string } & TurnSettings)
  | { t: 'named'; at: string; id: string; title: string }
  | { t: 'deleted'; at: string; id: string }

export type RunStoreEvents = { change: [Run] }

/** Finished states an orchestrator is waiting to hear about. A deliberate stop is not one. */
const REPORTABLE: readonly RunStatus[] = ['done', 'failed']

/**
 * Every run Grip has started: an append-only event log (`runs.jsonl`) plus one folder per run
 * holding each turn's message and output. Runs belong to Grip, not to whichever chat started
 * them, so any orchestrator can list them and wait on them later.
 */
export class RunStore extends EventEmitter<RunStoreEvents> {
  private readonly runs = new Map<string, Run>()
  private readonly createdSeq = new Map<string, number>()
  private readonly finishedSeq = new Map<string, number>()
  private readonly events = new Map<string, RunEvent[]>()
  /** Runs you deleted. Their log lines, turn files and worktree stay; Grip stops showing them. */
  private readonly deleted = new Set<string>()
  private seq = 0
  private readonly log: JsonlAppender

  private constructor(
    private readonly dir: string,
    private readonly now: () => Date,
  ) {
    super()
    this.setMaxListeners(0)
    this.log = new JsonlAppender(this.logPath)
  }

  /** Open (or create) the store in `dir` and replay its log. */
  static async open(dir: string, now: () => Date = () => new Date()): Promise<RunStore> {
    await mkdir(join(dir, 'runs'), { recursive: true })
    const store = new RunStore(dir, now)
    for (const event of await readJsonl<RunEvent>(store.logPath)) store.apply(event)
    return store
  }

  private get logPath(): string {
    return join(this.dir, 'runs.jsonl')
  }

  private runDir(id: string): string {
    return join(this.dir, 'runs', id)
  }

  private stamp(): string {
    return this.now().toISOString()
  }

  private apply(e: RunEvent): Run | undefined {
    // Log position orders runs: timestamps tie within a millisecond, the log never does.
    const seq = ++this.seq
    if (e.t === 'created') {
      // Runs logged before chats existed have no chat and no app-side read mark.
      this.runs.set(e.run.id, {
        ...e.run,
        chatId: e.run.chatId ?? null,
        fromUser: e.run.fromUser ?? [],
        seen: e.run.seen ?? e.run.viewed,
      })
      this.createdSeq.set(e.run.id, seq)
      this.events.set(e.run.id, [e])
      return this.runs.get(e.run.id)
    }
    const run = this.runs.get(e.id)
    if (!run) return undefined
    this.events.get(e.id)?.push(e)
    if (e.t === 'turn-ended' || e.t === 'interrupted') this.finishedSeq.set(e.id, seq)
    run.updatedAt = e.at
    switch (e.t) {
      case 'turn-started':
        run.status = 'running'
        run.turns = Math.max(run.turns, e.turn)
        run.error = null
        run.finishedAt = null
        if (e.fromUser) run.fromUser = [...run.fromUser, e.turn]
        break
      case 'turn-ended':
        run.turns = Math.max(run.turns, e.turn)
        run.status = e.error ? 'failed' : 'done'
        run.error = e.error
        run.finishedAt = e.at
        run.viewed = false
        run.seen = false
        if (e.sessionId) run.engineSessionId = e.sessionId
        break
      case 'stopped':
        run.status = 'stopped'
        run.finishedAt = e.at
        break
      case 'configured':
        run.model = e.model
        run.effort = e.effort
        break
      case 'named':
        run.title = e.title
        break
      case 'deleted':
        this.deleted.add(e.id)
        break
      case 'interrupted':
        run.status = 'failed'
        run.error = e.reason
        run.finishedAt = e.at
        run.viewed = false
        run.seen = false
        break
      case 'viewed':
        if (e.by === 'app') run.seen = true
        else run.viewed = true
        break
    }
    return run
  }

  /** Apply an event, write it to the log, and tell listeners. Writes stay in order. */
  private async record(e: RunEvent): Promise<Run> {
    const run = this.apply(e)
    if (!run) throw new Error(`unknown run ${'id' in e ? e.id : e.run.id}`)
    await this.log.append(e)
    const copy = structuredClone(run)
    this.emit('change', copy)
    return copy
  }

  private must(id: string): Run {
    const run = this.runs.get(id)
    if (!run) throw new Error(`unknown run ${id}`)
    return run
  }

  /** Record a new run whose first turn, the brief, is about to be sent. */
  async create(input: NewRun): Promise<Run> {
    const at = this.stamp()
    const id = `r-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    const run: Run = {
      id,
      title: input.title,
      engine: input.engine,
      model: input.model ?? null,
      effort: input.effort ?? null,
      folder: input.folder,
      cwd: input.cwd,
      repo: input.repo,
      brief: input.brief,
      session: `grip-${id}`,
      engineSessionId: null,
      retryOf: input.retryOf ?? null,
      chatId: input.chatId ?? null,
      status: 'running',
      error: null,
      turns: 0,
      fromUser: [],
      viewed: true,
      seen: true,
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
    }
    await mkdir(this.runDir(id), { recursive: true })
    return this.record({ t: 'created', at, run })
  }

  /** A message is going to the worker. Returns the turn number. */
  async startTurn(id: string, message: string, options: { fromUser?: boolean } = {}): Promise<number> {
    const turn = this.must(id).turns + 1
    await writeFile(join(this.runDir(id), `turn-${turn}.in.md`), message)
    await this.record({ t: 'turn-started', at: this.stamp(), id, turn, ...(options.fromUser ? { fromUser: true as const } : {}) })
    return turn
  }

  /** The worker's turn is over: its output, and an error when it failed. */
  async endTurn(id: string, turn: number, result: { output: string; error?: string | null; sessionId?: string | null }): Promise<Run> {
    await this.saveOutput(id, turn, result.output)
    return this.record({
      t: 'turn-ended',
      at: this.stamp(),
      id,
      turn,
      error: result.error ?? null,
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    })
  }

  /** Keep a turn's output without changing the run, for a turn that ends after the run was stopped. */
  async saveOutput(id: string, turn: number, output: string): Promise<void> {
    this.must(id)
    await writeFile(join(this.runDir(id), `turn-${turn}.out.md`), output)
  }

  /** Change the model and effort the run's next turns use. */
  async configure(id: string, settings: TurnSettings): Promise<Run> {
    const run = this.must(id)
    if (run.model === settings.model && run.effort === settings.effort) return structuredClone(run)
    return this.record({ t: 'configured', at: this.stamp(), id, ...settings })
  }

  async rename(id: string, title: string): Promise<Run> {
    const run = this.must(id)
    if (run.title === title) return structuredClone(run)
    return this.record({ t: 'named', at: this.stamp(), id, title })
  }

  /**
   * Stop showing a run. Stop it first; this only hides it. A turn that ends later still saves
   * its output, out of sight.
   */
  async delete(id: string): Promise<void> {
    this.must(id)
    if (!this.deleted.has(id)) await this.record({ t: 'deleted', at: this.stamp(), id })
  }

  isDeleted(id: string): boolean {
    return this.deleted.has(id)
  }

  async markStopped(id: string): Promise<Run> {
    this.must(id)
    return this.record({ t: 'stopped', at: this.stamp(), id })
  }

  /** Mark a run read by its orchestrator (the default) or by you in the app. */
  async markViewed(id: string, by: Reader = 'orchestrator'): Promise<Run> {
    const run = this.must(id)
    if (by === 'app' ? run.seen : run.viewed) return structuredClone(run)
    return this.record({ t: 'viewed', at: this.stamp(), id, ...(by === 'app' ? { by: 'app' as const } : {}) })
  }

  /** Every event of one run, oldest first: the raw material of a chat's thread. */
  history(id: string): RunEvent[] {
    return structuredClone(this.events.get(id) ?? [])
  }

  /**
   * Fail every run still marked running, for when Grip starts after the machine slept,
   * restarted, or Claw went down. Nothing stays stuck as running.
   */
  async interruptRunning(reason: string): Promise<Run[]> {
    const stuck = [...this.runs.values()].filter(r => r.status === 'running')
    const out: Run[] = []
    for (const r of stuck) out.push(await this.record({ t: 'interrupted', at: this.stamp(), id: r.id, reason }))
    return out
  }

  get(id: string): Run | null {
    const run = this.deleted.has(id) ? undefined : this.runs.get(id)
    return run ? structuredClone(run) : null
  }

  /**
   * Runs newest first, optionally only one status, one folder or one chat (null: runs with no
   * chat). Deleted runs only with `deleted`, for the worktrees they leave behind.
   */
  list(filter: { status?: RunStatus; folder?: string; chatId?: string | null; deleted?: boolean } = {}): Run[] {
    return [...this.runs.values()]
      .filter(
        r =>
          (filter.deleted || !this.deleted.has(r.id)) &&
          (!filter.status || r.status === filter.status) &&
          (!filter.folder || r.folder === filter.folder) &&
          (filter.chatId === undefined || r.chatId === filter.chatId),
      )
      .sort((a, b) => (this.createdSeq.get(b.id) ?? 0) - (this.createdSeq.get(a.id) ?? 0))
      .map(r => structuredClone(r))
  }

  /** Active runs: the supervisor updates Claw only when this is empty. */
  running(): Run[] {
    return this.list({ status: 'running' })
  }

  /** One turn's message and output, as far as they exist. */
  async turn(id: string, turn: number): Promise<{ message: string | null; output: string | null }> {
    this.must(id)
    const read = (name: string) => readFile(join(this.runDir(id), name), 'utf8').catch(() => null)
    const [message, output] = await Promise.all([read(`turn-${turn}.in.md`), read(`turn-${turn}.out.md`)])
    return { message, output }
  }

  /**
   * The oldest finished run nobody has read yet, waiting up to `timeoutMs` for one. This is the
   * orchestrator's handoff: delegate several, then take results one at a time as they land.
   * With `chatId`, only that chat's runs count (null: runs with no chat), unless `ids` names
   * runs outright, so one chat never takes another's results.
   */
  waitAny(options: { timeoutMs: number; ids?: readonly string[]; chatId?: string | null; signal?: AbortSignal }): Promise<Run | null> {
    const mine = (r: Run) => (options.ids ? options.ids.includes(r.id) : options.chatId === undefined || r.chatId === options.chatId)
    const wanted = (r: Run) => REPORTABLE.includes(r.status) && !r.viewed && !this.deleted.has(r.id) && mine(r)
    const ready = [...this.runs.values()]
      .filter(wanted)
      .sort((a, b) => (this.finishedSeq.get(a.id) ?? 0) - (this.finishedSeq.get(b.id) ?? 0))[0]
    if (ready) return Promise.resolve(structuredClone(ready))
    return new Promise(resolve => {
      const done = (run: Run | null) => {
        clearTimeout(timer)
        this.off('change', onChange)
        options.signal?.removeEventListener('abort', onAbort)
        resolve(run)
      }
      const onChange = (run: Run) => {
        if (wanted(run)) done(run)
      }
      const onAbort = () => done(null)
      const timer = setTimeout(() => done(null), options.timeoutMs)
      this.on('change', onChange)
      options.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}
