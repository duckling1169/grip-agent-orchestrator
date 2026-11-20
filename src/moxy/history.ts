import type { Database } from '../db/database.js'
import type { Row } from '../db/rows.js'

export type Speaker = 'user' | 'moxy'
export type HistorySearchInput = { words: string; since?: string; until?: string; limit?: number }
export type HistoryHit = { ref: string; at: string; speaker: Speaker; snippet: string }
export type HistoryReadInput = { ref: string; around?: number }
export type HistoryMessage = { ref: string; at: string; speaker: Speaker; text: string }

const TIMELINE_SQL = `
  SELECT 'user:' || id AS ref, received_at AS at, 'user' AS speaker, json_extract(body, '$.text') AS text
  FROM inbox
  WHERE kind = 'user_message' AND json_extract(body, '$.text') IS NOT NULL
  UNION ALL
  SELECT 'moxy:' || id AS ref, COALESCE(ended_at, started_at) AS at, 'moxy' AS speaker, output AS text
  FROM leader_turns
  WHERE status != 'running' AND output IS NOT NULL
`

const TIMELINE = `SELECT ref, at, speaker, text FROM (${TIMELINE_SQL})`

const SNIPPET_CHARS = 300
const READ_TEXT_LIMIT = 4000
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const REF_PATTERN = /^(user|moxy):(\d+)$/

export class ConversationHistory {
  constructor(private readonly database: Database) {}

  search(input: HistorySearchInput): HistoryHit[] {
    const terms = input.words.trim().split(/\s+/).filter(Boolean)
    if (!terms.length) throw new Error('words must contain at least one search term')
    const limit = input.limit ?? 5
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('limit must be an integer between 1 and 10')

    const clauses: string[] = []
    const params: (string | number)[] = []
    for (const term of terms) {
      clauses.push(`text LIKE ? ESCAPE '\\'`)
      params.push(`%${term.replace(/[\\%_]/g, '\\$&')}%`)
    }
    if (input.since !== undefined) {
      clauses.push('at >= ?')
      params.push(parseBound(input.since, 'start', 'since'))
    }
    if (input.until !== undefined) {
      clauses.push('at <= ?')
      params.push(parseBound(input.until, 'end', 'until'))
    }
    params.push(limit)

    const sql = `${TIMELINE} WHERE ${clauses.join(' AND ')} ORDER BY at DESC, ref DESC LIMIT ?`
    const rows = this.database.prepare(sql).all(...params) as Row[]
    return rows.map(row => ({ ...messageMeta(row), snippet: makeSnippet(String(row.text), terms) }))
  }

  read(input: HistoryReadInput): HistoryMessage[] {
    const around = input.around ?? 3
    if (!Number.isInteger(around) || around < 0 || around > 10) throw new Error('around must be an integer between 0 and 10')
    const target = this.getTarget(input.ref)
    if (around === 0) return [target]

    return [...this.neighbours(target, 'before', around).reverse(), target, ...this.neighbours(target, 'after', around)]
  }

  private neighbours(target: HistoryMessage, side: 'before' | 'after', count: number): HistoryMessage[] {
    const [compare, order] = side === 'before' ? ['<', 'DESC'] : ['>', 'ASC']
    const rows = this.database
      .prepare(`${TIMELINE} WHERE at ${compare} ? OR (at = ? AND ref ${compare} ?) ORDER BY at ${order}, ref ${order} LIMIT ?`)
      .all(target.at, target.at, target.ref, count) as Row[]
    return rows.map(toMessage)
  }

  private getTarget(ref: string): HistoryMessage {
    if (!REF_PATTERN.test(ref)) throw new Error(`unknown history ref: ${ref}`)
    const row = this.database.prepare(`${TIMELINE} WHERE ref = ?`).get(ref) as Row | undefined
    if (!row) throw new Error(`unknown history ref: ${ref}`)
    return toMessage(row)
  }
}

function parseBound(value: string, edge: 'start' | 'end', label: string): string {
  if (DATE_ONLY.test(value)) return `${value}${edge === 'start' ? 'T00:00:00.000Z' : 'T23:59:59.999Z'}`
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) throw new Error(`invalid ${label} date: ${value}`)
  return new Date(parsed).toISOString()
}

function makeSnippet(text: string, terms: readonly string[]): string {
  if (text.length <= SNIPPET_CHARS) return text
  const lower = text.toLowerCase()
  let firstIndex = text.length
  let firstLength = 0
  for (const term of terms) {
    const index = lower.indexOf(term.toLowerCase())
    if (index !== -1 && index < firstIndex) {
      firstIndex = index
      firstLength = term.length
    }
  }
  const anchor = firstIndex === text.length ? 0 : firstIndex
  const start = Math.max(0, Math.min(anchor - Math.floor((SNIPPET_CHARS - firstLength) / 2), text.length - SNIPPET_CHARS))
  const end = Math.min(text.length, start + SNIPPET_CHARS)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

function messageMeta(row: Row): Pick<HistoryMessage, 'ref' | 'at' | 'speaker'> {
  return { ref: String(row.ref), at: String(row.at), speaker: String(row.speaker) as Speaker }
}

function toMessage(row: Row): HistoryMessage {
  const text = String(row.text)
  return { ...messageMeta(row), text: text.length <= READ_TEXT_LIMIT ? text : `${text.slice(0, READ_TEXT_LIMIT - 1)}…` }
}
