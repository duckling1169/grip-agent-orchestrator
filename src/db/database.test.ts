import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { temporaryHome } from '../testing/harness.js'
import { Database, DatabaseInUseError } from './database.js'
import type { Schema } from './database.js'

const NOTES: Schema = { version: 1, statements: ['CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT'] }

async function openNotes() {
  const path = join(await temporaryHome(), 'moxy.db')
  return { path, database: Database.open(path, NOTES) }
}

const bodies = (database: Database) =>
  database
    .prepare('SELECT body FROM notes ORDER BY id')
    .all()
    .map(row => row.body)

describe('Database', () => {
  it('commits a transaction and keeps it after reopening', async () => {
    const { path, database } = await openNotes()
    database.transaction(() => database.prepare('INSERT INTO notes (body) VALUES (?)').run('kept'))
    database.close()

    const reopened = Database.open(path, NOTES)
    expect(bodies(reopened)).toEqual(['kept'])
    reopened.close()
  })

  it('rolls back every write in a transaction that throws', async () => {
    const { database } = await openNotes()
    expect(() =>
      database.transaction(() => {
        database.prepare('INSERT INTO notes (body) VALUES (?)').run('lost')
        throw new Error('outcome unknown')
      }),
    ).toThrow('outcome unknown')
    expect(bodies(database)).toEqual([])
    database.close()
  })

  it('refuses asynchronous work inside a transaction and rolls it back', async () => {
    const { database } = await openNotes()
    expect(() =>
      database.transaction(async () => {
        database.prepare('INSERT INTO notes (body) VALUES (?)').run('lost')
      }),
    ).toThrow('synchronously')
    expect(bodies(database)).toEqual([])
    database.close()
  })

  it('refuses a second connection while the first is open', async () => {
    const { path, database } = await openNotes()
    expect(() => Database.open(path, NOTES)).toThrow(DatabaseInUseError)
    database.close()
    Database.open(path, NOTES).close()
  })

  it('refuses a database written by a different schema version', async () => {
    const { path, database } = await openNotes()
    database.close()
    expect(() => Database.open(path, { version: 2, statements: [] })).toThrow('schema version 1 is not the expected 2')
  })
})
