import type { ConversationEntry, LeaderSettings, LeaderTurn, LeaderTurnStatus, Recovery, Turn, Worker } from '../contracts/api.js'
import type { Engine } from '../contracts/engines.js'
import { LEADER_ENGINES } from '../contracts/engines.js'
import type { Database } from '../db/database.js'
import { numberOrNull, textOrNull } from '../db/rows.js'
import type { Row } from '../db/rows.js'

export type LeaderState = LeaderSettings & {
  nativeSessionId: string | null
  sessionEpoch: number
  sessionChars: number
  sessionTurns: number
  contextUsed: number | null
  contextLimit: number | null
}
export type SessionPolicy = Partial<typeof DEFAULT_SESSION_POLICY>

const DEFAULT_SESSION_POLICY = { maxChars: 128000, maxTurns: 20, contextRatio: 0.8 }

export type WorkerTurnEnded = {
  workerId: string
  taskId: string | null
  title: string
  turn: number
  status: string
  output: string | null
  error: string | null
}

export type InboxItem =
  | { kind: 'user_message'; source: string; body: { text: string } }
  | { kind: 'worker_turn_ended'; source: string; body: WorkerTurnEnded }
  | { kind: 'follow_up'; source: string; body: { id: string; prompt: string; dueAt: string } }

export type ReceivedItem = InboxItem & { id: number; receivedAt: string; leaderTurnId: number | null; interruptedDeliveries: number }

export type LeaderTurnEnding = {
  status: 'finished' | 'failed'
  output: string | null
  error: string | null
  nativeSessionId: string | null
  recovery?: Recovery | null
  context?: { used: number; limit: number }
  inputChars?: number
}

export function workerTurnEnded(worker: Worker, turn: Turn): InboxItem {
  return {
    kind: 'worker_turn_ended',
    source: `worker:${worker.id}:${turn.number}`,
    body: {
      workerId: worker.id,
      taskId: worker.taskId,
      title: worker.title,
      turn: turn.number,
      status: turn.status,
      output: turn.output,
      error: turn.error,
    },
  }
}

export function userMessage(text: string, id: string): InboxItem {
  return { kind: 'user_message', source: `user:${id}`, body: { text } }
}

const now = () => new Date().toISOString()

export class ConversationStore {
  constructor(
    private readonly database: Database,
    private readonly policy: SessionPolicy = {},
  ) {}

  receive(item: InboxItem): boolean {
    const inserted = this.database
      .prepare('INSERT INTO inbox (source, kind, body, received_at) VALUES (?, ?, ?, ?) ON CONFLICT (source) DO NOTHING')
      .run(item.source, item.kind, JSON.stringify(item.body), now())
    return inserted.changes > 0
  }

  leader(): LeaderState {
    const row = this.database.prepare('SELECT * FROM leader WHERE id = 1').get() as Row
    return {
      engine: String(row.engine) as Engine,
      model: textOrNull(row, 'model'),
      effort: textOrNull(row, 'effort'),
      nativeSessionId: textOrNull(row, 'native_session_id'),
      sessionEpoch: Number(row.session_epoch),
      sessionChars: Number(row.session_chars),
      sessionTurns: Number(row.session_turns),
      contextUsed: numberOrNull(row, 'context_used'),
      contextLimit: numberOrNull(row, 'context_limit'),
    }
  }

  beginTurn(): { turn: LeaderTurn; items: ReceivedItem[]; nativeSessionId: string | null } | null {
    return this.database.transaction(() => {
      if (this.database.prepare(`SELECT 1 FROM leader_turns WHERE status = 'running'`).get()) return null
      const pending = this.pendingItems()
      if (pending.length === 0) return null
      let leader = this.leader()
      if (leader.nativeSessionId && this.sessionFull(leader)) {
        this.resetNative()
        leader = this.leader()
      }
      const inserted = this.database
        .prepare(
          `INSERT INTO leader_turns (engine, model, effort, status, started_at, session_epoch) VALUES (?, ?, ?, 'running', ?, ?) RETURNING id`,
        )
        .get(leader.engine, leader.model, leader.effort, now(), leader.sessionEpoch) as Row
      const turnId = Number(inserted.id)
      this.database.prepare('UPDATE inbox SET leader_turn_id = ? WHERE leader_turn_id IS NULL').run(turnId)
      return {
        turn: this.mustGetTurn(turnId),
        items: pending.map(item => ({ ...item, leaderTurnId: turnId })),
        nativeSessionId: leader.nativeSessionId,
      }
    })
  }

  endTurn(turnId: number, ending: LeaderTurnEnding): LeaderTurn {
    this.database.transaction(() => {
      const ended = this.database
        .prepare(
          `UPDATE leader_turns SET status = ?, output = ?, error = ?, recovery = ?, ended_at = ? WHERE id = ? AND status = 'running'`,
        )
        .run(ending.status, ending.output, ending.error, ending.recovery ? JSON.stringify(ending.recovery) : null, now(), turnId)
      const turn = this.database.prepare('SELECT session_epoch FROM leader_turns WHERE id = ?').get(turnId) as Row | undefined
      if (ended.changes > 0 && Number(turn?.session_epoch) === this.leader().sessionEpoch) {
        if (ending.status === 'finished' && ending.nativeSessionId) {
          this.database
            .prepare(
              `UPDATE leader SET native_session_id = ?, session_chars = session_chars + ?, session_turns = session_turns + 1, context_used = ?, context_limit = ? WHERE id = 1`,
            )
            .run(
              ending.nativeSessionId,
              (ending.inputChars ?? 0) + (ending.output?.length ?? 0),
              ending.context?.used ?? null,
              ending.context?.limit ?? null,
            )
        } else this.resetNative()
      }
    })
    return this.mustGetTurn(turnId)
  }

  configure(settings: LeaderSettings): LeaderState {
    if (!(LEADER_ENGINES as readonly Engine[]).includes(settings.engine)) throw new Error(`${settings.engine} cannot lead Moxy`)
    const current = this.leader()
    if (current.engine !== settings.engine || current.model !== settings.model || current.effort !== settings.effort) {
      this.database
        .prepare('UPDATE leader SET engine = ?, model = ?, effort = ? WHERE id = 1')
        .run(settings.engine, settings.model, settings.effort)
      this.resetNative()
    }
    return this.leader()
  }

  stopRunningTurn(reason: string): LeaderTurn | null {
    const row = this.database
      .prepare(`UPDATE leader_turns SET status = 'stopped', error = ?, ended_at = ? WHERE status = 'running' RETURNING id`)
      .get(reason, now()) as Row | undefined
    if (!row) return null
    this.resetNative()
    return this.mustGetTurn(Number(row.id))
  }

  retryTurn(turnId: number, settings?: LeaderSettings): LeaderTurn {
    return this.database.transaction(() => {
      const turn = this.mustGetTurn(turnId)
      if (turn.status !== 'failed' || turn.retried)
        throw new Error(`leader turn ${turnId} is ${turn.retried ? 'already retried' : turn.status}; only a failed turn can be retried`)
      if (settings) this.configure(settings)
      this.database.prepare('UPDATE leader_turns SET retried_at = ? WHERE id = ?').run(now(), turnId)
      this.database.prepare('UPDATE inbox SET leader_turn_id = NULL WHERE leader_turn_id = ?').run(turnId)
      return this.mustGetTurn(turnId)
    })
  }

  runningTurn(): LeaderTurn | null {
    const row = this.database.prepare(`SELECT * FROM leader_turns WHERE status = 'running'`).get() as Row | undefined
    return row ? toTurn(row) : null
  }

  interruptRunningTurn(reason: string): LeaderTurn | null {
    return this.database.transaction(() => {
      const row = this.database
        .prepare(`UPDATE leader_turns SET status = 'interrupted', error = ?, ended_at = ? WHERE status = 'running' RETURNING id`)
        .get(reason, now()) as Row | undefined
      if (!row) return null
      const turnId = Number(row.id)
      this.resetNative()
      this.database
        .prepare('UPDATE inbox SET leader_turn_id = NULL, interrupted_deliveries = interrupted_deliveries + 1 WHERE leader_turn_id = ?')
        .run(turnId)
      return this.mustGetTurn(turnId)
    })
  }

  runningTurnStartedByUser(): boolean {
    const row = this.database
      .prepare(
        `SELECT 1 FROM inbox JOIN leader_turns ON leader_turns.id = inbox.leader_turn_id
         WHERE leader_turns.status = 'running' AND inbox.kind = 'user_message' LIMIT 1`,
      )
      .get()
    return row !== undefined
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

  private sessionFull(leader: LeaderState): boolean {
    const policy = { ...DEFAULT_SESSION_POLICY, ...this.policy }
    const contextRatio = leader.contextUsed !== null && leader.contextLimit ? leader.contextUsed / leader.contextLimit : 0
    return leader.sessionChars >= policy.maxChars || leader.sessionTurns >= policy.maxTurns || contextRatio >= policy.contextRatio
  }

  private resetNative(): void {
    this.database
      .prepare(
        'UPDATE leader SET native_session_id = NULL, session_epoch = session_epoch + 1, session_chars = 0, session_turns = 0, context_used = NULL, context_limit = NULL WHERE id = 1',
      )
      .run()
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
    retried: row.retried_at !== null,
    recovery: row.recovery === null || row.recovery === undefined ? null : (JSON.parse(String(row.recovery)) as Recovery),
  }
}
