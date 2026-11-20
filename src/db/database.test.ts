import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it, onTestFinished } from 'vitest'

import { temporaryHome } from '../testing/harness.js'
import { Database, DatabaseInUseError } from './database.js'
import type { Schema } from './database.js'
import { MOXY_SCHEMA } from './schema.js'

const NOTES: Schema = {
  version: 1,
  statements: ['CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT'],
  upgrades: {},
}

const NOTES_V2: Schema = {
  version: 2,
  statements: [
    'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT',
    'CREATE TABLE tags (name TEXT PRIMARY KEY) STRICT',
  ],
  upgrades: { 2: ['CREATE TABLE tags (name TEXT PRIMARY KEY) STRICT'] },
}

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
  it('bumps the revision once after a batch of writes and not after reads', async () => {
    const { database } = await openNotes()
    const revisions: number[] = []
    database.onChange(revision => revisions.push(revision))
    database.transaction(() => {
      database.prepare('INSERT INTO notes (body) VALUES (?)').run('one')
      database.prepare('INSERT INTO notes (body) VALUES (?)').run('two')
    })
    await new Promise(resolve => setImmediate(resolve))
    bodies(database)
    await new Promise(resolve => setImmediate(resolve))
    database.prepare('DELETE FROM notes WHERE body = ?').run('one')
    await new Promise(resolve => setImmediate(resolve))

    expect(revisions).toEqual([1, 2])
    expect(database.revision).toBe(2)
    database.close()
  })

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

  it('upgrades a database forward, backs up the old version, and keeps existing rows', async () => {
    const { path, database } = await openNotes()
    database.prepare('INSERT INTO notes (body) VALUES (?)').run('kept')
    database.close()

    const upgraded = Database.open(path, NOTES_V2)
    onTestFinished(() => upgraded.close())
    expect(bodies(upgraded)).toEqual(['kept'])
    expect(upgraded.prepare('PRAGMA user_version').get()?.user_version).toBe(2)
    upgraded.prepare('INSERT INTO tags (name) VALUES (?)').run('v2')
    expect(upgraded.prepare('SELECT name FROM tags').all()).toEqual([{ name: 'v2' }])

    const backupPath = `${path}.v1.bak`
    expect(existsSync(backupPath)).toBe(true)
    const backup = Database.open(backupPath, NOTES)
    onTestFinished(() => backup.close())
    expect(bodies(backup)).toEqual(['kept'])
  })

  it('refuses an upgrade with a missing step without modifying or backing up the database', async () => {
    const { path, database } = await openNotes()
    database.prepare('INSERT INTO notes (body) VALUES (?)').run('untouched')
    database.close()

    expect(() => Database.open(path, { version: 2, statements: [], upgrades: {} })).toThrow(
      'cannot upgrade database schema from version 1 to 2',
    )
    expect(existsSync(`${path}.v1.bak`)).toBe(false)
    const reopened = Database.open(path, NOTES)
    onTestFinished(() => reopened.close())
    expect(bodies(reopened)).toEqual(['untouched'])
  })

  it('rolls back a failing upgrade and leaves the old version and data intact', async () => {
    const { path, database } = await openNotes()
    database.prepare('INSERT INTO notes (body) VALUES (?)').run('safe')
    database.close()

    expect(() =>
      Database.open(path, {
        version: 2,
        statements: [],
        upgrades: { 2: ['CREATE TABLE tags (name TEXT PRIMARY KEY) STRICT', 'CREATE TABLE broken'] },
      }),
    ).toThrow()
    const reopened = Database.open(path, NOTES)
    onTestFinished(() => reopened.close())
    expect(reopened.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
    expect(bodies(reopened)).toEqual(['safe'])
  })

  it('refuses a database written by a newer Moxy', async () => {
    const { path, database } = await openNotes()
    database.close()
    const v2 = Database.open(path, NOTES_V2)
    v2.close()

    expect(() => Database.open(path, NOTES)).toThrow('newer')
  })

  it('upgrades a v2 MOXY_SCHEMA database to v3 matching a fresh v3 schema', async () => {
    const v3Upgrade = MOXY_SCHEMA.upgrades[3] ?? []
    const v2Schema: Schema = {
      version: 2,
      statements: MOXY_SCHEMA.statements.filter(statement => !v3Upgrade.includes(statement)),
      upgrades: {},
    }
    const v2Path = join(await temporaryHome(), 'v2.db')
    const v2 = Database.open(v2Path, v2Schema)
    v2.prepare('UPDATE memory SET preferences = ? WHERE id = 1').run('Keep tests focused')
    v2.close()

    const upgraded = Database.open(v2Path, MOXY_SCHEMA)
    onTestFinished(() => upgraded.close())
    expect(upgraded.prepare('SELECT preferences FROM memory WHERE id = 1').get()?.preferences).toBe('Keep tests focused')

    const freshPath = join(await temporaryHome(), 'fresh.db')
    const fresh = Database.open(freshPath, MOXY_SCHEMA)
    onTestFinished(() => fresh.close())
    const masterSql = 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name'
    expect(upgraded.prepare(masterSql).all()).toEqual(fresh.prepare(masterSql).all())
  })

  it('releases the database when creating the schema fails', async () => {
    const path = join(await temporaryHome(), 'moxy.db')
    expect(() => Database.open(path, { version: 1, statements: ['CREATE TABLE broken'], upgrades: {} })).toThrow()
    Database.open(path, NOTES).close()
    await unlink(path)
  })
})
