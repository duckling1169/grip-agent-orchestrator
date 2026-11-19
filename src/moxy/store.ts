import type { Engine } from '../contracts/engines.js'
import type { Database } from '../db/database.js'
import { numberOrNull, textOrNull } from '../db/rows.js'
import type { Row } from '../db/rows.js'
import type { Turn, Worker } from '../workers/store.js'

export type LeaderSettings = { engine: Engine; model: string | null; effort: string | null; nativeSessionId: string | null }

export type LeaderTurnStatus = 'running' | 'finished' | 'failed' | 'interrupted'

export type LeaderTurn = {
  id: number
  engine: Engine
  model: string | null
  effort: string | null
  status: LeaderTurnStatus
  output: string | null
  error: string | null
  startedAt: string
  endedAt: string | null
}

export type WorkerTurnEnded = {
  workerId: string
  title: string
  turn: number
  status: string
  output: string | null
  error: string | null
}

export type InboxItem =
  { kind: 'user_message'; source: string; body: { text: string } } | { kind: 'worker_turn_ended'; source: string; body: WorkerTurnEnded }

export type ReceivedItem = InboxItem & { id: number; receivedAt: string; leaderTurnId: number | null; interruptedDeliveries: number }

export type LeaderTurnEnding = {
  status: 'finished' | 'failed'
  output: string | null
  error: string | null
  nativeSessionId: string | null
}

export type ConversationEntry =
  | { type: 'user'; inboxId: number; source: string; text: string; at: string; leaderTurnId: number | null }
  | { type: 'moxy'; turn: LeaderTurn }

export function workerTurnEnded(worker: Worker, turn: Turn): InboxItem {
  return {
    kind: 'worker_turn_ended',
    source: `worker:${worker.id}:${turn.number}`,
    body: { workerId: worker.id, title: worker.title, turn: turn.number, status: turn.status, output: turn.output, error: turn.error },
  }
}

export function userMessage(text: string, id: string): InboxItem {
  return { kind: 'user_message', source: `user:${id}`, body: { text } }
}

const now = () => new Date().toISOString()

export class ConversationStore {
  constructor(private readonly database: Database) {}

  receive(item: InboxItem): boolean {
    const inserted = this.database
      .prepare('INSERT INTO inbox (source, kind, body, received_at) VALUES (?, ?, ?, ?) ON CONFLICT (source) DO NOTHING')
      .run(item.source, item.kind, JSON.stringify(item.body), now())
    return inserted.changes > 0
  }

  leader(): LeaderSettings {
    const row = this.database.prepare('SELECT * FROM leader WHERE id = 1').get() as Row
    return {
      engine: String(row.engine) as Engine,
      model: textOrNull(row, 'model'),
      effort: textOrNull(row, 'effort'),
      nativeSessionId: textOrNull(row, 'native_session_id'),
    }
  }

  beginTurn(): { turn: LeaderTurn; items: ReceivedItem[] } | null {
    return this.database.transaction(() => {
      if (this.database.prepare(`SELECT 1 FROM leader_turns WHERE status = 'running'`).get()) return null
      const pending = this.pendingItems()
      if (pending.length === 0) return null
      const leader = this.leader()
      const inserted = this.database
        .prepare(`INSERT INTO leader_turns (engine, model, effort, status, started_at) VALUES (?, ?, ?, 'running', ?) RETURNING id`)
        .get(leader.engine, leader.model, leader.effort, now()) as Row
      const turnId = Number(inserted.id)
      this.database.prepare('UPDATE inbox SET leader_turn_id = ? WHERE leader_turn_id IS NULL').run(turnId)
      return { turn: this.mustGetTurn(turnId), items: pending.map(item => ({ ...item, leaderTurnId: turnId })) }
    })
  }

  endTurn(turnId: number, ending: LeaderTurnEnding): LeaderTurn {
    this.database.transaction(() => {
      const ended = this.database
        .prepare(`UPDATE leader_turns SET status = ?, output = ?, error = ?, ended_at = ? WHERE id = ? AND status = 'running'`)
        .run(ending.status, ending.output, ending.error, now(), turnId)
      if (ended.changes > 0 && ending.nativeSessionId) {
        this.database.prepare('UPDATE leader SET native_session_id = ? WHERE id = 1').run(ending.nativeSessionId)
      }
    })
    return this.mustGetTurn(turnId)
  }

  interruptRunningTurn(reason: string): LeaderTurn | null {
    return this.database.transaction(() => {
      const row = this.database
        .prepare(`UPDATE leader_turns SET status = 'interrupted', error = ?, ended_at = ? WHERE status = 'running' RETURNING id`)
        .get(reason, now()) as Row | undefined
      if (!row) return null
      const turnId = Number(row.id)
      this.database
        .prepare('UPDATE inbox SET leader_turn_id = NULL, interrupted_deliveries = interrupted_deliveries + 1 WHERE leader_turn_id = ?')
        .run(turnId)
      return this.mustGetTurn(turnId)
    })
  }

  conversation(): ConversationEntry[] {
    const users = (this.database.prepare(`SELECT * FROM inbox WHERE kind = 'user_message' ORDER BY id`).all() as Row[]).map(toItem)
    const turns = (this.database.prepare('SELECT * FROM leader_turns ORDER BY id').all() as Row[]).map(toTurn)
    const timed: [string, ConversationEntry][] = [
      ...users.map((item): [string, ConversationEntry] => [
        item.receivedAt,
        {
          type: 'user',
          inboxId: item.id,
          source: item.source,
          text: item.kind === 'user_message' ? item.body.text : '',
          at: item.receivedAt,
          leaderTurnId: item.leaderTurnId,
        },
      ]),
      ...turns.map((turn): [string, ConversationEntry] => [turn.endedAt ?? turn.startedAt, { type: 'moxy', turn }]),
    ]
    return timed.sort(([a], [b]) => a.localeCompare(b)).map(([, entry]) => entry)
  }

  private pendingItems(): ReceivedItem[] {
    const rows = this.database.prepare('SELECT * FROM inbox WHERE leader_turn_id IS NULL ORDER BY id').all() as Row[]
    return rows.map(toItem)
  }

  private mustGetTurn(id: number): LeaderTurn {
    const row = this.database.prepare('SELECT * FROM leader_turns WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error(`unknown leader turn ${id}`)
    return toTurn(row)
  }
}

function toItem(row: Row): ReceivedItem {
  return {
    id: Number(row.id),
    source: String(row.source),
    kind: String(row.kind),
    body: JSON.parse(String(row.body)),
    receivedAt: String(row.received_at),
    leaderTurnId: numberOrNull(row, 'leader_turn_id'),
    interruptedDeliveries: Number(row.interrupted_deliveries),
  } as ReceivedItem
}

function toTurn(row: Row): LeaderTurn {
  return {
    id: Number(row.id),
    engine: String(row.engine) as Engine,
    model: textOrNull(row, 'model'),
    effort: textOrNull(row, 'effort'),
    status: String(row.status) as LeaderTurnStatus,
    output: textOrNull(row, 'output'),
    error: textOrNull(row, 'error'),
    startedAt: String(row.started_at),
    endedAt: textOrNull(row, 'ended_at'),
  }
}
