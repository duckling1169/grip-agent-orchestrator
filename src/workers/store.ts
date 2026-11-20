import type { Turn, TurnStatus, Worker } from '../contracts/api.js'
import type { Engine } from '../contracts/engines.js'
import { now } from '../clock.js'
import type { Database } from '../db/database.js'
import { textOrNull, turnFields } from '../db/rows.js'
import type { Row } from '../db/rows.js'
import { workerTurnEnded } from '../moxy/store.js'
import type { ConversationStore } from '../moxy/store.js'

export type EndedTurnStatus = Exclude<TurnStatus, 'running'>

export type NewWorker = Pick<Worker, 'id' | 'taskId' | 'title' | 'engine' | 'model' | 'effort' | 'folder' | 'cwd' | 'repo'>

export type TurnEnding = { status: EndedTurnStatus; output: string | null; error: string | null; nativeSessionId?: string | null }

export type TurnRef = { workerId: string; number: number }

const WORKER_SELECT = `
  SELECT w.*, t.status AS status, t.number AS turn_count, t.started_at AS turn_started_at
  FROM workers w
  JOIN worker_turns t ON t.worker_id = w.id AND t.number = (SELECT MAX(number) FROM worker_turns WHERE worker_id = w.id)`

export class WorkerStore {
  constructor(
    private readonly database: Database,
    private readonly conversation?: Pick<ConversationStore, 'receive'>,
  ) {}

  create(worker: NewWorker, input: string): Worker {
    this.database.transaction(() => {
      if (worker.taskId && this.database.prepare('SELECT status FROM tasks WHERE id = ?').get(worker.taskId)?.status === 'done') {
        throw new Error(`task ${worker.taskId} is done; reopen it first`)
      }
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
    return this.database.transaction(() => {
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
      const turn = this.turn(ref)
      if (ended.changes > 0) this.recordCompletion(ref.workerId, turn)
      return turn
    })
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
    return this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `UPDATE worker_turns SET status = ?, error = ?, ended_at = ?
           WHERE status = 'running' ${condition}
           RETURNING worker_id, number`,
        )
        .all(status, error, now(), ...params) as Row[]
      const refs = rows.map(row => ({ workerId: String(row.worker_id), number: Number(row.number) }))
      for (const ref of refs) this.recordCompletion(ref.workerId, this.turn(ref))
      return refs
    })
  }

  private recordCompletion(workerId: string, turn: Turn): void {
    this.conversation?.receive(workerTurnEnded(this.mustGet(workerId), turn))
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
  return { ...turnFields(row), number: Number(row.number), input: String(row.input) }
}
