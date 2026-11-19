// Inbox timers follow William Hu's Building always-on agents: https://claude.com/resources/articles/building-always-on-agents.

import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import type { Database } from '../db/database.js'
import type { Row } from '../db/rows.js'
import { textOrNull } from '../db/rows.js'

export type FollowUp = {
  id: string
  source: string
  prompt: string
  dueAt: string
  status: 'pending' | 'done' | 'cancelled'
  createdAt: string
  endedAt: string | null
}
export type FollowUpOptions = { wake: () => void; now?: () => number; onError?: (error: unknown) => void }

export const FOLLOW_UP_PROMPT_LIMIT = 8000
const MAX_TIMER_MS = 86400000
const DueTime = z.iso.datetime({ offset: true })

export class FollowUps {
  private readonly now: () => number
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private closed = false

  constructor(
    private readonly database: Database,
    private readonly options: FollowUpOptions,
  ) {
    this.now = options.now ?? Date.now
  }

  schedule(input: { dueAt: string; prompt: string }): FollowUp {
    this.assertOpen()
    const date = Date.parse(input.dueAt)
    if (!DueTime.safeParse(input.dueAt).success || !Number.isFinite(date)) throw new Error('dueAt must be an ISO timestamp with a timezone')
    const prompt = input.prompt.trim()
    if (!prompt || prompt.length > FOLLOW_UP_PROMPT_LIMIT) throw new Error(`prompt must contain 1 to ${FOLLOW_UP_PROMPT_LIMIT} characters`)
    const count = Number(this.database.prepare(`SELECT COUNT(*) AS count FROM follow_ups WHERE status = 'pending'`).get()?.count)
    if (count >= 256) throw new Error('Follow-up limit reached; cancel an existing timer first')
    const id = randomUUID()
    const source = `follow-up:${id}`
    this.database
      .prepare(`INSERT INTO follow_ups (id, source, prompt, due_at, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`)
      .run(id, source, prompt, new Date(date).toISOString(), new Date(this.now()).toISOString())
    this.arm()
    return this.mustGet(id)
  }

  cancel(id: string): FollowUp {
    this.assertOpen()
    const row = this.mustGet(id)
    if (row.status !== 'pending') throw new Error(`follow-up ${id} is ${row.status}; only pending timers can be cancelled`)
    this.database
      .prepare(`UPDATE follow_ups SET status = 'cancelled', ended_at = ? WHERE id = ? AND status = 'pending'`)
      .run(new Date(this.now()).toISOString(), id)
    this.arm()
    return this.mustGet(id)
  }

  list(): FollowUp[] {
    return (this.database.prepare('SELECT * FROM follow_ups ORDER BY due_at, id').all() as Row[]).map(toFollowUp)
  }

  start(): void {
    this.assertOpen()
    if (this.started) return
    this.started = true
    this.tick()
  }

  deliverDue(): number {
    if (this.closed) return 0
    const at = new Date(this.now()).toISOString()
    const inserted = this.database.transaction(() => {
      const due = (
        this.database.prepare(`SELECT * FROM follow_ups WHERE status = 'pending' AND due_at <= ? ORDER BY due_at, id`).all(at) as Row[]
      ).map(toFollowUp)
      let count = 0
      for (const row of due) {
        const body = JSON.stringify({ id: row.id, prompt: row.prompt, dueAt: row.dueAt })
        const result = this.database
          .prepare(`INSERT INTO inbox (source, kind, body, received_at) VALUES (?, 'follow_up', ?, ?) ON CONFLICT (source) DO NOTHING`)
          .run(row.source, body, at)
        count += Number(result.changes)
        this.database.prepare(`UPDATE follow_ups SET status = 'done', ended_at = ? WHERE id = ? AND status = 'pending'`).run(at, row.id)
      }
      return count
    })
    if (inserted) this.options.wake()
    return inserted
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private tick(): void {
    try {
      this.deliverDue()
      this.arm()
    } catch (error) {
      this.options.onError?.(error)
      this.arm(1000)
    }
  }

  private arm(minimumMs = 1): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.started || this.closed) return
    const next = this.database.prepare(`SELECT due_at FROM follow_ups WHERE status = 'pending' ORDER BY due_at LIMIT 1`).get()
    if (!next) return
    const delay = Math.min(MAX_TIMER_MS, Math.max(minimumMs, Date.parse(String(next.due_at)) - this.now()))
    this.timer = setTimeout(() => {
      this.timer = null
      this.tick()
    }, delay)
    this.timer.unref()
  }

  private mustGet(id: string): FollowUp {
    const row = this.database.prepare('SELECT * FROM follow_ups WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error(`unknown follow-up ${id}`)
    return toFollowUp(row)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Follow-up scheduler is closed')
  }
}

function toFollowUp(row: Row): FollowUp {
  return {
    id: String(row.id),
    source: String(row.source),
    prompt: String(row.prompt),
    dueAt: String(row.due_at),
    status: String(row.status) as FollowUp['status'],
    createdAt: String(row.created_at),
    endedAt: textOrNull(row, 'ended_at'),
  }
}
