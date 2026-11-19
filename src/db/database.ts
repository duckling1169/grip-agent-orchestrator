import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'

export type Schema = { version: number; statements: readonly string[] }

export class DatabaseInUseError extends Error {
  constructor(readonly path: string) {
    super(`${path} is in use by another Moxy`)
    this.name = 'DatabaseInUseError'
  }
}

const SQLITE_BUSY = 5

export class Database {
  private constructor(private readonly connection: DatabaseSync) {}

  static open(path: string, schema: Schema): Database {
    mkdirSync(dirname(path), { recursive: true })
    const connection = new DatabaseSync(path, { timeout: 0 })
    try {
      holdExclusiveLock(connection)
    } catch (error) {
      connection.close()
      throw (error as { errcode?: number }).errcode === SQLITE_BUSY ? new DatabaseInUseError(path) : error
    }
    const database = new Database(connection)
    database.applySchema(schema)
    return database
  }

  prepare(sql: string): StatementSync {
    return this.connection.prepare(sql)
  }

  transaction<T>(work: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      if (result instanceof Promise) throw new Error('a transaction must finish synchronously')
      this.connection.exec('COMMIT')
      return result
    } catch (error) {
      this.connection.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.connection.close()
  }

  private applySchema(schema: Schema): void {
    const version = Number(this.connection.prepare('PRAGMA user_version').get()?.user_version)
    if (version === schema.version) return
    if (version !== 0) throw new Error(`database schema version ${version} is not the expected ${schema.version}`)
    this.transaction(() => {
      for (const statement of schema.statements) this.connection.exec(statement)
      this.connection.exec(`PRAGMA user_version = ${schema.version}`)
    })
  }
}

function holdExclusiveLock(connection: DatabaseSync): void {
  connection.exec('PRAGMA locking_mode = EXCLUSIVE')
  connection.exec('BEGIN EXCLUSIVE')
  connection.exec('COMMIT')
}
