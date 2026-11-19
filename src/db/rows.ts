export type Row = Record<string, string | number | null>

export const textOrNull = (row: Row, key: string): string | null => (row[key] === null ? null : String(row[key]))

export const numberOrNull = (row: Row, key: string): number | null => (row[key] === null ? null : Number(row[key]))
