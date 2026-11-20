import type { TurnFields, TurnStatus } from '../contracts/api.js'

export type Row = Record<string, string | number | null>

export const textOrNull = (row: Row, key: string): string | null => (row[key] === null ? null : String(row[key]))

export const numberOrNull = (row: Row, key: string): number | null => (row[key] === null ? null : Number(row[key]))

export function turnFields(row: Row): TurnFields {
  return {
    model: textOrNull(row, 'model'),
    effort: textOrNull(row, 'effort'),
    status: String(row.status) as TurnStatus,
    output: textOrNull(row, 'output'),
    error: textOrNull(row, 'error'),
    startedAt: String(row.started_at),
    endedAt: textOrNull(row, 'ended_at'),
  }
}
