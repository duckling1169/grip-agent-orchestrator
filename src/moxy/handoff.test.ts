import { join } from 'node:path'

import { expect, it, onTestFinished } from 'vitest'

import { Database } from '../db/database.js'
import { MOXY_SCHEMA } from '../db/schema.js'
import { silentLog, temporaryHome } from '../testing/harness.js'
import type { LeaderTurnRequest } from '../runtime/leaders/leader.js'
import { LeaderLoop } from './loop.js'
import { ConversationStore, userMessage } from './store.js'

async function setup() {
  const database = Database.open(join(await temporaryHome(), 'moxy.db'), MOXY_SCHEMA)
  onTestFinished(() => database.close())
  return { database, conversation: new ConversationStore(database) }
}

it('switches at the boundary and refuses to persist a late native session from the old engine', async () => {
  const { conversation } = await setup()
  conversation.receive(userMessage('First', 'one'))
  const first = conversation.beginTurn()!
  conversation.configure({ engine: 'codex', model: 'new-model', effort: 'high' })
  conversation.endTurn(first.turn.id, { status: 'finished', output: 'First answer', error: null, nativeSessionId: 'claude-session' })
  expect(conversation.leader()).toMatchObject({ engine: 'codex', nativeSessionId: null })
  conversation.receive(userMessage('Second', 'two'))
  const next = conversation.beginTurn()!
  expect(next.turn).toMatchObject({ engine: 'codex', model: 'new-model', effort: 'high' })
  expect(next.nativeSessionId).toBeNull()
})

it('starts fresh for model changes and atomic switch-and-retry without losing the failed inbox', async () => {
  const { conversation } = await setup()
  conversation.receive(userMessage('Keep my task', 'one'))
  const first = conversation.beginTurn()!
  conversation.endTurn(first.turn.id, { status: 'failed', output: null, error: 'quota exhausted', nativeSessionId: 'old-session' })
  conversation.retryTurn(first.turn.id, { engine: 'codex', model: null, effort: null })
  const next = conversation.beginTurn()!
  expect(next.turn.engine).toBe('codex')
  expect(next.nativeSessionId).toBeNull()
  expect(next.items).toMatchObject([{ body: { text: 'Keep my task' } }])
  conversation.endTurn(next.turn.id, { status: 'finished', output: 'Done', error: null, nativeSessionId: 'codex-session' })
  conversation.configure({ engine: 'codex', model: 'different-model', effort: null })
  expect(conversation.leader().nativeSessionId).toBeNull()
  expect(() => conversation.retryTurn(first.turn.id, { engine: 'claude', model: null, effort: null })).toThrow('already retried')
  expect(conversation.leader().engine).toBe('codex')
})

it('rotates at reported context capacity and seeds fresh sessions while keeping ordinary native continuation lean', async () => {
  const { conversation } = await setup()
  const requests: LeaderTurnRequest[] = []
  let instructions = 'Use focused tests'
  const loop = new LeaderLoop({
    conversation,
    cwd: '/work',
    systemPrompt: async () => 'Leader prompt',
    mcp: { url: '', token: '' },
    timeoutMs: 1000,
    log: silentLog,
    seed: () => 'Preserved task plan and feedback',
    instructions: () => instructions,
    runners: () => ({
      stop: async () => {},
      run: async request => {
        requests.push(request)
        return {
          output: 'Answer',
          error: null,
          nativeSessionId: `session-${requests.length}`,
          context: { used: requests.length === 2 ? 85 : 10, limit: 100 },
        }
      },
    }),
  })
  for (const id of ['one', 'two', 'three']) {
    if (id === 'two') instructions = 'Preserve the existing URL'
    conversation.receive(userMessage(id, id))
    loop.wake()
    await loop.idle()
  }
  expect(requests[0]).toMatchObject({ nativeSessionId: null })
  expect(requests[0]!.message).toContain('Preserved task plan and feedback')
  expect(requests[1]!.nativeSessionId).toBe('session-1')
  expect(requests[1]!.message).not.toContain('Preserved task plan and feedback')
  expect(requests[1]!.message).toContain('Preserve the existing URL')
  expect(requests[2]!.nativeSessionId).toBeNull()
  expect(requests[2]!.message).toContain('Preserved task plan and feedback')
})

it('does not spend a model turn when fresh cached provider quota is exhausted', async () => {
  const { conversation } = await setup()
  let calls = 0
  const loop = new LeaderLoop({
    conversation,
    cwd: '/work',
    systemPrompt: async () => 'Leader prompt',
    mcp: { url: '', token: '' },
    timeoutMs: 1000,
    log: silentLog,
    available: () => true,
    quota: () => [
      {
        engine: 'claude',
        checkedAt: new Date().toISOString(),
        busy: false,
        error: null,
        windows: [
          { name: '5h', usedPercent: 100, stale: false, observedAt: new Date().toISOString(), resetsAt: '2099-01-01T00:00:00.000Z' },
        ],
      },
    ],
    runners: () => ({
      stop: async () => {},
      run: async () => {
        calls++
        return { output: '', error: null, nativeSessionId: null }
      },
    }),
  })
  conversation.receive(userMessage('Do this', 'one'))
  loop.wake()
  await loop.idle()
  expect(calls).toBe(0)
  expect(conversation.conversation()).toMatchObject([
    { type: 'user', text: 'Do this' },
    {
      type: 'moxy',
      turn: { status: 'failed', recovery: { provider: 'claude', resetsAt: '2099-01-01T00:00:00.000Z', suggested: { engine: 'codex' } } },
    },
  ])
})
