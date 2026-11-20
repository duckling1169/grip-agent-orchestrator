import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'

export type Schema = {
  version: number
  statements: readonly string[]
  upgrades: Readonly<Record<number, readonly string[]>>
}

export class DatabaseInUseError extends Error {
  constructor(readonly path: string) {
    super(`${path} is in use by another Moxy`)
    this.name = 'DatabaseInUseError'
  }
}

const SQLITE_BUSY = 5

export class Database {
  private readonly listeners = new Set<(revision: number) => void>()
  private changesSeen = 0
  private checkScheduled = false
  private closed = false
  private currentRevision = 0

  private constructor(private readonly connection: DatabaseSync) {}

  static open(path: string, schema: Schema): Database {
    mkdirSync(dirname(path), { recursive: true })
    const connection = new DatabaseSync(path, { timeout: 0 })
    try {
      holdExclusiveLock(connection)
      connection.exec('PRAGMA foreign_keys = ON')
      const database = new Database(connection)
      database.applySchema(schema, path)
      database.changesSeen = database.totalChanges()
      return database
    } catch (error) {
      connection.close()
      throw (error as { errcode?: number }).errcode === SQLITE_BUSY ? new DatabaseInUseError(path) : error
    }
  }

  get revision(): number {
    return this.currentRevision
  }

  prepare(sql: string): StatementSync {
    this.scheduleChangeCheck()
    return this.connection.prepare(sql)
  }

  onChange(listener: (revision: number) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
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
    this.closed = true
    this.connection.close()
  }

  private scheduleChangeCheck(): void {
    if (this.checkScheduled) return
    this.checkScheduled = true
    setImmediate(() => {
      this.checkScheduled = false
      if (this.closed || this.connection.isTransaction) return
      const total = this.totalChanges()
      if (total === this.changesSeen) return
      this.changesSeen = total
      this.currentRevision++
      for (const listener of this.listeners) listener(this.currentRevision)
    })
  }

  private totalChanges(): number {
    return Number(this.connection.prepare('SELECT total_changes() AS total').get()?.total)
  }

  private applySchema(schema: Schema, path: string): void {
    const version = Number(this.connection.prepare('PRAGMA user_version').get()?.user_version)
    if (version === schema.version) return
    if (version > schema.version) {
      throw new Error(`database schema version ${version} is from a newer Moxy; this Moxy expects version ${schema.version}`)
    }
    if (version === 0) {
      this.transaction(() => {
        for (const statement of schema.statements) this.connection.exec(statement)
        this.connection.exec(`PRAGMA user_version = ${schema.version}`)
      })
      return
    }
    const steps: (readonly string[])[] = []
    for (let next = version + 1; next <= schema.version; next++) {
      const statements = schema.upgrades[next]
      if (!statements) throw new Error(`cannot upgrade database schema from version ${version} to ${schema.version}`)
      steps.push(statements)
    }
    const backupPath = `${path}.v${version}.bak`
    rmSync(backupPath, { force: true })
    this.connection.prepare('VACUUM INTO ?').run(backupPath)
    this.transaction(() => {
      for (const statements of steps) {
        for (const statement of statements) this.connection.exec(statement)
      }
      this.connection.exec(`PRAGMA user_version = ${schema.version}`)
    })
  }
}

function holdExclusiveLock(connection: DatabaseSync): void {
  connection.exec('PRAGMA locking_mode = EXCLUSIVE')
  connection.exec('BEGIN EXCLUSIVE')
  connection.exec('COMMIT')
}
