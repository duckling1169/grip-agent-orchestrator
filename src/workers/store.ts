import type { Turn, TurnStatus, Worker } from '../contracts/api.js'
import type { Engine } from '../contracts/engines.js'
import type { Database } from '../db/database.js'
import { textOrNull } from '../db/rows.js'
import type { Row } from '../db/rows.js'

export type EndedTurnStatus = Exclude<TurnStatus, 'running'>

export type NewWorker = Pick<Worker, 'id' | 'taskId' | 'title' | 'engine' | 'model' | 'effort' | 'folder' | 'cwd' | 'repo'>

export type TurnEnding = { status: EndedTurnStatus; output: string | null; error: string | null; nativeSessionId?: string | null }

export type TurnRef = { workerId: string; number: number }

const WORKER_SELECT = `
  SELECT w.*, t.status AS status, t.number AS turn_count, t.started_at AS turn_started_at
  FROM workers w
  JOIN worker_turns t ON t.worker_id = w.id AND t.number = (SELECT MAX(number) FROM worker_turns WHERE worker_id = w.id)`

const now = () => new Date().toISOString()

export class WorkerStore {
  constructor(private readonly database: Database) {}

  create(worker: NewWorker, input: string): Worker {
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO workers (id, task_id, title, engine, model, effort, folder, cwd, repo_root, branch, base, base_commit, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          worker.id,
          worker.taskId,
          worker.title,
          worker.engine,
          worker.model,
          worker.effort,
          worker.folder,
          worker.cwd,
          worker.repo?.root ?? null,
          worker.repo?.branch ?? null,
          worker.repo?.base ?? null,
          worker.repo?.baseCommit ?? null,
          now(),
        )
      this.insertTurn(worker.id, 1, worker, input)
    })
    return this.mustGet(worker.id)
  }

  startTurn(workerId: string, input: string): number {
    return this.database.transaction(() => {
      const worker = this.mustGet(workerId)
      if (worker.status === 'running') throw new Error(`worker ${workerId} is still working; wait for it or stop it first`)
      const number = worker.turnCount + 1
      this.insertTurn(workerId, number, worker, input)
      return number
    })
  }

  endTurn(ref: TurnRef, ending: TurnEnding): Turn {
    this.database.transaction(() => {
      const ended = this.database
        .prepare(
          `UPDATE worker_turns SET status = ?, output = ?, error = ?, ended_at = ? WHERE worker_id = ? AND number = ? AND status = 'running'`,
        )
        .run(ending.status, ending.output, ending.error, now(), ref.workerId, ref.number)
      if (ended.changes === 0 && ending.output !== null) {
        this.database
          .prepare('UPDATE worker_turns SET output = ? WHERE worker_id = ? AND number = ? AND output IS NULL')
          .run(ending.output, ref.workerId, ref.number)
      }
      if (ending.nativeSessionId) {
        this.database.prepare('UPDATE workers SET native_session_id = ? WHERE id = ?').run(ending.nativeSessionId, ref.workerId)
      }
    })
    return this.turn(ref)
  }

  stopRunningTurn(workerId: string): TurnRef | null {
    return this.endRunning('stopped', null, 'AND worker_id = ?', workerId)[0] ?? null
  }

  interruptRunningTurns(reason: string): TurnRef[] {
    return this.endRunning('interrupted', reason, '')
  }

  get(id: string): Worker | null {
    const row = this.database.prepare(`${WORKER_SELECT} WHERE w.id = ?`).get(id) as Row | undefined
    return row ? toWorker(row) : null
  }

  mustGet(id: string): Worker {
    const worker = this.get(id)
    if (!worker) throw new Error(`unknown worker ${id}`)
    return worker
  }

  list(): Worker[] {
    return (this.database.prepare(`${WORKER_SELECT} ORDER BY w.created_at DESC`).all() as Row[]).map(toWorker)
  }

  listForTask(taskId: string): Worker[] {
    return (this.database.prepare(`${WORKER_SELECT} WHERE w.task_id = ? ORDER BY w.created_at`).all(taskId) as Row[]).map(toWorker)
  }

  turns(workerId: string): Turn[] {
    return (this.database.prepare('SELECT * FROM worker_turns WHERE worker_id = ? ORDER BY number').all(workerId) as Row[]).map(toTurn)
  }

  turnStatus(ref: TurnRef): TurnStatus {
    return this.turn(ref).status
  }

  turn(ref: TurnRef): Turn {
    const row = this.database.prepare('SELECT * FROM worker_turns WHERE worker_id = ? AND number = ?').get(ref.workerId, ref.number) as
      Row | undefined
    if (!row) throw new Error(`unknown turn ${ref.number} of worker ${ref.workerId}`)
    return toTurn(row)
  }

  private insertTurn(workerId: string, number: number, settings: Pick<Worker, 'model' | 'effort'>, input: string): void {
    this.database
      .prepare(
        `INSERT INTO worker_turns (worker_id, number, model, effort, input, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(workerId, number, settings.model, settings.effort, input, now())
  }

  private endRunning(status: EndedTurnStatus, error: string | null, condition: string, ...params: string[]): TurnRef[] {
    const rows = this.database
      .prepare(
        `UPDATE worker_turns SET status = ?, error = ?, ended_at = ?
         WHERE status = 'running' ${condition}
         RETURNING worker_id, number`,
      )
      .all(status, error, now(), ...params) as Row[]
    return rows.map(row => ({ workerId: String(row.worker_id), number: Number(row.number) }))
  }
}

function toWorker(row: Row): Worker {
  return {
    id: String(row.id),
    taskId: textOrNull(row, 'task_id'),
    title: String(row.title),
    engine: String(row.engine) as Engine,
    model: textOrNull(row, 'model'),
    effort: textOrNull(row, 'effort'),
    folder: String(row.folder),
    cwd: String(row.cwd),
    repo:
      row.repo_root === null
        ? null
        : { root: String(row.repo_root), branch: String(row.branch), base: String(row.base), baseCommit: String(row.base_commit) },
    nativeSessionId: textOrNull(row, 'native_session_id'),
    createdAt: String(row.created_at),
    status: String(row.status) as TurnStatus,
    turnCount: Number(row.turn_count),
    turnStartedAt: String(row.turn_started_at),
  }
}

function toTurn(row: Row): Turn {
  return {
    number: Number(row.number),
    model: textOrNull(row, 'model'),
    effort: textOrNull(row, 'effort'),
    input: String(row.input),
    output: textOrNull(row, 'output'),
    status: String(row.status) as TurnStatus,
    error: textOrNull(row, 'error'),
    startedAt: String(row.started_at),
    endedAt: textOrNull(row, 'ended_at'),
  }
}
