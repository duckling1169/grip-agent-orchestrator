import type { Integration, IntegrationStatus, Task, TaskStatus } from '../contracts/api.js'
import type { Database } from '../db/database.js'
import { textOrNull } from '../db/rows.js'
import type { Row } from '../db/rows.js'

export type TaskNotes = Partial<Pick<Task, 'title' | 'plan' | 'notes' | 'testing'>>

const NOTE_COLUMNS = { title: 'title', plan: 'plan', notes: 'notes', testing: 'testing' } as const

const now = () => new Date().toISOString()

export class TaskStore {
  constructor(private readonly database: Database) {}

  create(task: Pick<Task, 'id' | 'title' | 'repoRoot' | 'plan' | 'testing'>): Task {
    const at = now()
    this.database
      .prepare(
        `INSERT INTO tasks (id, title, repo_root, plan, testing, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'working', ?, ?)`,
      )
      .run(task.id, task.title, task.repoRoot, task.plan, task.testing, at, at)
    return this.mustGet(task.id)
  }

  update(id: string, notes: TaskNotes): Task {
    const fields = Object.entries(NOTE_COLUMNS).filter(([key]) => notes[key as keyof TaskNotes] !== undefined)
    if (fields.length) {
      const assignments = fields.map(([, column]) => `${column} = ?`).join(', ')
      const values = fields.map(([key]) => notes[key as keyof TaskNotes] as string)
      this.changed(this.database.prepare(`UPDATE tasks SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values, now(), id), id)
    }
    return this.mustGet(id)
  }

  deliver(id: string, revision: string | null, howToTry: string): Task {
    const run = this.database
      .prepare(`UPDATE tasks SET status = 'done', revision = ?, how_to_try = ?, superseded_by = NULL, updated_at = ? WHERE id = ?`)
      .run(revision, howToTry, now(), id)
    this.changed(run, id)
    return this.mustGet(id)
  }

  reopen(id: string, note: string): Task {
    const run = this.database
      .prepare(
        `UPDATE tasks SET status = 'working', notes = CASE WHEN notes = '' THEN ? ELSE notes || char(10) || char(10) || ? END, updated_at = ?
         WHERE id = ?`,
      )
      .run(note, note, now(), id)
    this.changed(run, id)
    return this.mustGet(id)
  }

  supersedeDone(repoRoot: string, revision: string): string[] {
    const rows = this.database
      .prepare(
        `UPDATE tasks SET superseded_by = ?, updated_at = ?
         WHERE repo_root = ? AND status = 'done' AND superseded_by IS NULL AND revision IS NOT ? RETURNING id`,
      )
      .all(revision, now(), repoRoot, revision) as Row[]
    return rows.map(row => String(row.id))
  }

  get(id: string): Task | null {
    const row = this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined
    return row ? toTask(row) : null
  }

  mustGet(id: string): Task {
    const task = this.get(id)
    if (!task) throw new Error(`unknown task ${id}`)
    return task
  }

  list(): Task[] {
    return (this.database.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all() as Row[]).map(toTask)
  }

  startIntegration(integration: Pick<Integration, 'taskId' | 'workerId' | 'repoRoot' | 'branch'>): number {
    const row = this.database
      .prepare(
        `INSERT INTO integrations (task_id, worker_id, repo_root, branch, status, started_at) VALUES (?, ?, ?, ?, 'running', ?) RETURNING id`,
      )
      .get(integration.taskId, integration.workerId, integration.repoRoot, integration.branch, now()) as Row
    return Number(row.id)
  }

  endIntegration(id: number, ending: { status: 'merged' | 'refused'; revision: string | null; error: string | null }): Integration {
    this.database
      .prepare(`UPDATE integrations SET status = ?, revision = ?, error = ?, ended_at = ? WHERE id = ? AND status = 'running'`)
      .run(ending.status, ending.revision, ending.error, now(), id)
    return this.mustGetIntegration(id)
  }

  interruptRunningIntegrations(reason: string): Integration[] {
    const rows = this.database
      .prepare(`UPDATE integrations SET status = 'interrupted', error = ?, ended_at = ? WHERE status = 'running' RETURNING *`)
      .all(reason, now()) as Row[]
    return rows.map(toIntegration)
  }

  integrations(taskId: string): Integration[] {
    return (this.database.prepare('SELECT * FROM integrations WHERE task_id = ? ORDER BY id').all(taskId) as Row[]).map(toIntegration)
  }

  private mustGetIntegration(id: number): Integration {
    const row = this.database.prepare('SELECT * FROM integrations WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error(`unknown integration ${id}`)
    return toIntegration(row)
  }

  private changed(run: { changes: number | bigint }, id: string): void {
    if (Number(run.changes) === 0) throw new Error(`unknown task ${id}`)
  }
}

function toTask(row: Row): Task {
  return {
    id: String(row.id),
    title: String(row.title),
    repoRoot: textOrNull(row, 'repo_root'),
    plan: String(row.plan),
    notes: String(row.notes),
    testing: String(row.testing),
    status: String(row.status) as TaskStatus,
    revision: textOrNull(row, 'revision'),
    howToTry: textOrNull(row, 'how_to_try'),
    supersededBy: textOrNull(row, 'superseded_by'),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function toIntegration(row: Row): Integration {
  return {
    id: Number(row.id),
    taskId: String(row.task_id),
    workerId: String(row.worker_id),
    repoRoot: String(row.repo_root),
    branch: String(row.branch),
    status: String(row.status) as IntegrationStatus,
    revision: textOrNull(row, 'revision'),
    error: textOrNull(row, 'error'),
    startedAt: String(row.started_at),
    endedAt: textOrNull(row, 'ended_at'),
  }
}
