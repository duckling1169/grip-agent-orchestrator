import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it, onTestFinished } from 'vitest'

import { Database } from '../db/database.js'
import { MOXY_SCHEMA } from '../db/schema.js'
import { temporaryHome, temporaryRepo } from '../testing/harness.js'
import { PROJECT_NOTE_LIMIT, ProjectNotes } from './notes.js'

async function setup() {
  const path = join(await temporaryHome(), 'moxy.db')
  const database = Database.open(path, MOXY_SCHEMA)
  onTestFinished(() => database.close())
  return { path, database, notes: new ProjectNotes(database) }
}

describe('ProjectNotes', () => {
  it('returns an empty body when no note exists, then updates, replaces and deletes with empty or whitespace body', async () => {
    const { notes } = await setup()
    const repo = await temporaryRepo()

    expect(await notes.read(repo)).toEqual({ repo, body: '', updatedAt: '' })

    const first = await notes.update(repo, 'Overview: CLI tool\nDecision: use SQLite')
    expect(first.repo).toBe(repo)
    expect(first.body).toBe('Overview: CLI tool\nDecision: use SQLite')
    expect(first.updatedAt).toBeTruthy()
    expect(await notes.read(repo)).toEqual(first)

    const replaced = await notes.update(repo, 'Updated overview')
    expect(replaced.body).toBe('Updated overview')
    expect(await notes.read(repo)).toEqual(replaced)

    const deleted = await notes.update(repo, '   \n\t  ')
    expect(deleted).toEqual({ repo, body: '', updatedAt: '' })
    expect(await notes.read(repo)).toEqual({ repo, body: '', updatedAt: '' })
    expect(notes.list()).toEqual([])

    await notes.update(repo, 'Saved again')
    await notes.update(repo, '')
    expect(notes.list()).toEqual([])
  })

  it('enforces the 8000-character limit', async () => {
    const { notes } = await setup()
    const repo = await temporaryRepo()
    await notes.update(repo, 'Initial note')

    await expect(notes.update(repo, 'x'.repeat(PROJECT_NOTE_LIMIT + 1))).rejects.toThrow(String(PROJECT_NOTE_LIMIT))
    expect((await notes.read(repo)).body).toBe('Initial note')
  })

  it('maps different path spellings and subfolders of a repository to one note', async () => {
    const { notes } = await setup()
    const repo = await temporaryRepo()
    const subfolder = join(repo, 'packages', 'core')
    await mkdir(subfolder, { recursive: true })

    await notes.update(subfolder, 'Shared note')

    const forwardSlashes = repo.replace(/\\/g, '/')
    const flippedDrive =
      process.platform === 'win32' && /^[a-z]:/i.test(forwardSlashes)
        ? `${forwardSlashes.charAt(0) === forwardSlashes.charAt(0).toUpperCase() ? forwardSlashes.charAt(0).toLowerCase() : forwardSlashes.charAt(0).toUpperCase()}${forwardSlashes.slice(1)}`
        : forwardSlashes

    expect((await notes.read(repo)).body).toBe('Shared note')
    expect((await notes.read(forwardSlashes)).body).toBe('Shared note')
    expect((await notes.read(flippedDrive)).body).toBe('Shared note')
    expect(notes.list()).toHaveLength(1)
  })

  it('rejects paths outside a git repository', async () => {
    const { notes } = await setup()
    const plainFolder = await temporaryHome()

    await expect(notes.read(plainFolder)).rejects.toThrow('git repository')
    await expect(notes.update(plainFolder, 'Nope')).rejects.toThrow('git repository')
    await expect(notes.read(join(plainFolder, 'missing'))).rejects.toThrow('folder not found')
  })

  it('lists notes newest first', async () => {
    const { database, notes } = await setup()
    const first = await temporaryRepo()
    const second = await temporaryRepo()
    const third = await temporaryRepo()

    database
      .prepare('INSERT INTO project_notes (repo_root, body, updated_at) VALUES (?, ?, ?)')
      .run(first, 'First', '2026-11-19T10:00:00.000Z')
    database
      .prepare('INSERT INTO project_notes (repo_root, body, updated_at) VALUES (?, ?, ?)')
      .run(second, 'Second', '2026-11-19T12:00:00.000Z')
    database
      .prepare('INSERT INTO project_notes (repo_root, body, updated_at) VALUES (?, ?, ?)')
      .run(third, 'Third', '2026-11-19T11:00:00.000Z')

    expect(notes.list()).toEqual([
      { repo: second, updatedAt: '2026-11-19T12:00:00.000Z' },
      { repo: third, updatedAt: '2026-11-19T11:00:00.000Z' },
      { repo: first, updatedAt: '2026-11-19T10:00:00.000Z' },
    ])
  })
})
