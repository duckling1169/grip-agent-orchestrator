import { now } from '../clock.js'
import type { Database } from '../db/database.js'
import type { Row } from '../db/rows.js'

export type UserMemory = { instructions: string; preferences: string; updatedAt: string }
export type MemoryUpdate = Partial<Pick<UserMemory, 'instructions' | 'preferences'>>

export const MEMORY_LIMITS = { instructions: 8000, preferences: 16000 } as const

export class Memory {
  constructor(private readonly database: Database) {}

  read(): UserMemory {
    const row = this.database.prepare('SELECT instructions, preferences, updated_at FROM memory WHERE id = 1').get() as Row
    return { instructions: String(row.instructions), preferences: String(row.preferences), updatedAt: String(row.updated_at) }
  }

  update(update: MemoryUpdate): UserMemory {
    for (const [field, limit] of Object.entries(MEMORY_LIMITS) as [keyof typeof MEMORY_LIMITS, number][]) {
      const value = update[field]
      if (value !== undefined && (typeof value !== 'string' || value.length > limit))
        throw new Error(`${field} must be at most ${limit} characters`)
    }
    return this.database.transaction(() => {
      const current = this.read()
      const instructions = update.instructions ?? current.instructions
      const preferences = update.preferences ?? current.preferences
      if (instructions !== current.instructions || preferences !== current.preferences) {
        this.database
          .prepare('UPDATE memory SET instructions = ?, preferences = ?, updated_at = ? WHERE id = 1')
          .run(instructions, preferences, now())
      }
      return this.read()
    })
  }
}
