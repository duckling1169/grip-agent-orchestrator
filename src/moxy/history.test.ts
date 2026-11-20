import { join } from 'node:path'

import { describe, expect, it, onTestFinished } from 'vitest'

import { Database } from '../db/database.js'
import { MOXY_SCHEMA } from '../db/schema.js'
import { temporaryHome } from '../testing/harness.js'
import { ConversationHistory } from './history.js'

async function setup() {
  const database = Database.open(join(await temporaryHome(), 'moxy.db'), MOXY_SCHEMA)
  onTestFinished(() => database.close())
  return { database, history: new ConversationHistory(database) }
}

function addUser(database: Database, id: number, text: string, at: string, kind = 'user_message') {
  database
    .prepare('INSERT INTO inbox (id, source, kind, body, received_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, `${kind}:${id}`, kind, JSON.stringify({ text }), at)
}

function addTurn(
  database: Database,
  id: number,
  output: string | null,
  at: string,
  status: 'finished' | 'running' | 'failed' = 'finished',
) {
  database
    .prepare(`INSERT INTO leader_turns (id, engine, status, output, started_at, ended_at) VALUES (?, 'claude', ?, ?, ?, ?)`)
    .run(id, status, output, at, status === 'running' ? null : at)
}

describe('ConversationHistory', () => {
  it('searches across both speakers with AND words, case-insensitivity, literal % and _, date bounds and limits', async () => {
    const { database, history } = await setup()
    addUser(database, 1, 'Alpha beta 100% pass_rate', '2026-11-18T10:00:00.000Z')
    addTurn(database, 1, 'Confirmed ALPHA and BETA in build', '2026-11-18T10:05:00.000Z')
    addUser(database, 2, 'Only alpha here', '2026-11-19T09:00:00.000Z')
    addTurn(database, 2, 'Alpha beta again on day two', '2026-11-19T11:00:00.000Z')
    addUser(database, 3, '1000% passXrate should not match', '2026-11-19T12:00:00.000Z')
    database
      .prepare('INSERT INTO inbox (id, source, kind, body, received_at) VALUES (?, ?, ?, ?, ?)')
      .run(
        4,
        'worker:w1:1',
        'worker_turn_ended',
        JSON.stringify({ text: 'alpha beta worker event', output: 'alpha beta' }),
        '2026-11-19T13:00:00.000Z',
      )
    database
      .prepare('INSERT INTO inbox (id, source, kind, body, received_at) VALUES (?, ?, ?, ?, ?)')
      .run(5, 'follow:1', 'follow_up', JSON.stringify({ prompt: 'alpha beta follow up' }), '2026-11-19T13:05:00.000Z')
    addTurn(database, 3, 'alpha beta running turn', '2026-11-19T14:00:00.000Z', 'running')

    const all = history.search({ words: 'alpha  BETA' })
    expect(all.map(hit => [hit.ref, hit.speaker])).toEqual([
      ['moxy:2', 'moxy'],
      ['moxy:1', 'moxy'],
      ['user:1', 'user'],
    ])

    expect(history.search({ words: '100% pass_rate' }).map(hit => hit.ref)).toEqual(['user:1'])
    expect(history.search({ words: 'alpha beta', since: '2026-11-19' }).map(hit => hit.ref)).toEqual(['moxy:2'])
    expect(history.search({ words: 'alpha beta', until: '2026-11-18' }).map(hit => hit.ref)).toEqual(['moxy:1', 'user:1'])
    expect(history.search({ words: 'alpha beta', limit: 2 }).map(hit => hit.ref)).toEqual(['moxy:2', 'moxy:1'])
  })

  it('centers the snippet around the first match with ellipses when cut', async () => {
    const { database, history } = await setup()
    const long = `${'prefix '.repeat(60)}TARGET_TOKEN${' suffix'.repeat(60)}`
    addUser(database, 1, long, '2026-11-19T10:00:00.000Z')

    const [hit] = history.search({ words: 'target_token' })
    expect(hit).toBeDefined()
    expect(hit!.snippet).toContain('TARGET_TOKEN')
    expect(hit!.snippet.startsWith('…')).toBe(true)
    expect(hit!.snippet.endsWith('…')).toBe(true)
    expect(hit!.snippet.length).toBeLessThanOrEqual(302)
  })

  it('reads messages around a user or moxy ref, handles edges, clips long messages and rejects unknown refs', async () => {
    const { database, history } = await setup()
    addUser(database, 1, 'First user', '2026-11-19T10:00:00.000Z')
    addTurn(database, 1, 'First moxy', '2026-11-19T10:01:00.000Z')
    addUser(database, 2, 'Second user', '2026-11-19T10:02:00.000Z')
    addTurn(database, 2, 'x'.repeat(5000), '2026-11-19T10:03:00.000Z')
    addUser(database, 3, 'Third user', '2026-11-19T10:04:00.000Z')

    const aroundMoxy = history.read({ ref: 'moxy:1', around: 1 })
    expect(aroundMoxy.map(entry => [entry.ref, entry.speaker, entry.text])).toEqual([
      ['user:1', 'user', 'First user'],
      ['moxy:1', 'moxy', 'First moxy'],
      ['user:2', 'user', 'Second user'],
    ])

    const atStart = history.read({ ref: 'user:1', around: 2 })
    expect(atStart.map(entry => entry.ref)).toEqual(['user:1', 'moxy:1', 'user:2'])

    const atEnd = history.read({ ref: 'user:3', around: 1 })
    expect(atEnd.map(entry => entry.ref)).toEqual(['moxy:2', 'user:3'])
    expect(atEnd[0]!.text.length).toBeLessThanOrEqual(4010)

    expect(() => history.read({ ref: 'user:999' })).toThrow('unknown')
    expect(() => history.read({ ref: 'invalid' })).toThrow('unknown')
  })
})
