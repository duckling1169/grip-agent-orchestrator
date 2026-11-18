import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
  retryOf: string | null
  status: RunStatus
  error: string | null
  /** Turns that have ended. */
  turns: number
  /** Cleared when the run finishes; set once its result is read in the app or by an orchestrator. */
  viewed: boolean
  createdAt: string
  updatedAt: string
  finishedAt: string | null
}

export type NewRun = Pick<Run, 'title' | 'engine' | 'folder' | 'cwd' | 'repo' | 'brief'> &
  Partial<Pick<Run, 'model' | 'effort' | 'retryOf'>>

/** One line of `runs.jsonl`. The log is the record; run state is rebuilt from it on load. */
type RunEvent =
  | { t: 'created'; at: string; run: Run }
  | { t: 'turn-started'; at: string; id: string; turn: number }
  | { t: 'turn-ended'; at: string; id: string; turn: number; error: string | null }
  | { t: 'stopped'; at: string; id: string }
  | { t: 'interrupted'; at: string; id: string; reason: string }
  | { t: 'viewed'; at: string; id: string }

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
  private seq = 0
  private writes: Promise<void> = Promise.resolve()

  private constructor(
    private readonly dir: string,
    private readonly now: () => Date,
  ) {
    super()
    this.setMaxListeners(0)
  }

  /** Open (or create) the store in `dir` and replay its log. */
  static async open(dir: string, now: () => Date = () => new Date()): Promise<RunStore> {
    await mkdir(join(dir, 'runs'), { recursive: true })
    const store = new RunStore(dir, now)
    let text = ''
    try {
      text = await readFile(store.logPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        store.apply(JSON.parse(line) as RunEvent)
      } catch {
        // A line cut short by a crash mid-write; everything before it still counts.
      }
    }
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
      this.runs.set(e.run.id, { ...e.run })
      this.createdSeq.set(e.run.id, seq)
      return this.runs.get(e.run.id)
    }
    const run = this.runs.get(e.id)
    if (!run) return undefined
    if (e.t === 'turn-ended' || e.t === 'interrupted') this.finishedSeq.set(e.id, seq)
    run.updatedAt = e.at
    switch (e.t) {
      case 'turn-started':
        run.status = 'running'
        run.error = null
        run.finishedAt = null
        break
      case 'turn-ended':
        run.turns = Math.max(run.turns, e.turn)
        run.status = e.error ? 'failed' : 'done'
        run.error = e.error
        run.finishedAt = e.at
        run.viewed = false
        break
      case 'stopped':
        run.status = 'stopped'
        run.finishedAt = e.at
        break
      case 'interrupted':
        run.status = 'failed'
        run.error = e.reason
        run.finishedAt = e.at
        run.viewed = false
        break
      case 'viewed':
        run.viewed = true
        break
    }
    return run
  }

  /** Apply an event, write it to the log, and tell listeners. Writes stay in order. */
  private async record(e: RunEvent): Promise<Run> {
    const run = this.apply(e)
    if (!run) throw new Error(`unknown run ${'id' in e ? e.id : e.run.id}`)
    const line = `${JSON.stringify(e)}\n`
    const write = this.writes.then(() => appendFile(this.logPath, line))
    // One failed write must not block every later one.
    this.writes = write.catch(() => undefined)
    await write
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
      retryOf: input.retryOf ?? null,
      status: 'running',
      error: null,
      turns: 0,
      viewed: true,
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
    }
    await mkdir(this.runDir(id), { recursive: true })
    return this.record({ t: 'created', at, run })
  }

  /** A message is going to the worker. Returns the turn number. */
  async startTurn(id: string, message: string): Promise<number> {
    const turn = this.must(id).turns + 1
    await writeFile(join(this.runDir(id), `turn-${turn}.in.md`), message)
    await this.record({ t: 'turn-started', at: this.stamp(), id, turn })
    return turn
  }

  /** The worker's turn is over: its output, and an error when it failed. */
  async endTurn(id: string, turn: number, result: { output: string; error?: string | null }): Promise<Run> {
    await writeFile(join(this.runDir(id), `turn-${turn}.out.md`), result.output)
    return this.record({ t: 'turn-ended', at: this.stamp(), id, turn, error: result.error ?? null })
  }

  async markStopped(id: string): Promise<Run> {
    this.must(id)
    return this.record({ t: 'stopped', at: this.stamp(), id })
  }

  async markViewed(id: string): Promise<Run> {
    if (this.must(id).viewed) return structuredClone(this.must(id))
    return this.record({ t: 'viewed', at: this.stamp(), id })
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
    const run = this.runs.get(id)
    return run ? structuredClone(run) : null
  }

  /** Runs newest first, optionally only one status or one folder. */
  list(filter: { status?: RunStatus; folder?: string } = {}): Run[] {
    return [...this.runs.values()]
      .filter(r => (!filter.status || r.status === filter.status) && (!filter.folder || r.folder === filter.folder))
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
   */
  waitAny(options: { timeoutMs: number; ids?: readonly string[]; signal?: AbortSignal }): Promise<Run | null> {
    const wanted = (r: Run) => REPORTABLE.includes(r.status) && !r.viewed && (!options.ids || options.ids.includes(r.id))
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
