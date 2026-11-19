import { join } from 'node:path'

import { describe, expect, it, onTestFinished } from 'vitest'

import type { LeaderTurn } from '../contracts/api.js'
import { Database } from '../db/database.js'
import { MOXY_SCHEMA } from '../db/schema.js'
import type { LeaderReply, LeaderRunner, LeaderTurnRequest } from '../runtime/leaders/leader.js'
import { silentLog, temporaryHome } from '../testing/harness.js'
import { LeaderLoop } from './loop.js'
import { renderInbox } from './prompt.js'
import { ConversationStore, userMessage } from './store.js'
import type { WorkerTurnEnded } from './store.js'

class ScriptedLeader implements LeaderRunner {
  readonly requests: LeaderTurnRequest[] = []
  stopped = 0
  private answers: ((reply: LeaderReply) => void)[] = []

  run(request: LeaderTurnRequest): Promise<LeaderReply> {
    this.requests.push(request)
    return new Promise(resolve => this.answers.push(resolve))
  }

  async stop(): Promise<void> {
    this.stopped++
    this.reply({ output: '', error: 'stopped', nativeSessionId: null })
  }

  reply(reply: LeaderReply): void {
    this.answers.shift()?.(reply)
  }

  async started(count: number): Promise<void> {
    for (let attempt = 0; attempt < 400 && this.requests.length < count; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(this.requests).toHaveLength(count)
  }
}

const workerEvent = (overrides: Partial<WorkerTurnEnded> = {}): WorkerTurnEnded => ({
  workerId: 'w1',
  taskId: 't1',
  title: 'Fix the bug',
  turn: 1,
  status: 'finished',
  output: 'Fixed it.',
  error: null,
  ...overrides,
})

async function setup() {
  const path = join(await temporaryHome(), 'moxy.db')
  let database = Database.open(path, MOXY_SCHEMA)
  onTestFinished(() => database.close())
  const leader = new ScriptedLeader()
  const ended: LeaderTurn[] = []
  const loopOn = (conversation: ConversationStore) =>
    new LeaderLoop({
      conversation,
      runners: () => leader,
      mcp: { url: 'http://127.0.0.1:1/mcp', token: 't' },
      cwd: '/work',
      systemPrompt: async engine => `Leader prompt for ${engine}`,
      timeoutMs: 1000,
      log: silentLog,
      onTurnEnded: turn => ended.push(turn),
    })
  const conversation = new ConversationStore(database)
  return {
    leader,
    ended,
    conversation,
    loop: loopOn(conversation),
    reopen: () => {
      database.close()
      database = Database.open(path, MOXY_SCHEMA)
      return new ConversationStore(database)
    },
  }
}

describe('ConversationStore', () => {
  it('knows whether the running turn started from a user message', async () => {
    const { conversation } = await setup()
    conversation.receive({ kind: 'worker_turn_ended', source: 'worker:w1:1', body: workerEvent() })
    conversation.beginTurn()
    expect(conversation.runningTurnStartedByUser()).toBe(false)
    conversation.endTurn(1, { status: 'finished', output: null, error: null, nativeSessionId: null })
    conversation.receive(userMessage('Ship it', 'a'))
    conversation.beginTurn()
    expect(conversation.runningTurnStartedByUser()).toBe(true)
  })

  it('drops a second item from the same source', async () => {
    const { conversation } = await setup()
    expect(conversation.receive(userMessage('hi', 'a'))).toBe(true)
    expect(conversation.receive(userMessage('hi again', 'a'))).toBe(false)
    expect(conversation.beginTurn()?.items).toHaveLength(1)
  })

  it('puts every pending item into one turn and starts no second turn while one runs', async () => {
    const { conversation } = await setup()
    conversation.receive(userMessage('one', 'a'))
    conversation.receive({ kind: 'worker_turn_ended', source: 'worker:w1:1', body: workerEvent() })
    const begun = conversation.beginTurn()
    expect(begun?.items.map(item => item.source)).toEqual(['user:a', 'worker:w1:1'])
    conversation.receive(userMessage('two', 'b'))
    expect(conversation.beginTurn()).toBeNull()
  })

  it('delivers the items of an interrupted turn again', async () => {
    const { conversation, reopen } = await setup()
    conversation.receive(userMessage('one', 'a'))
    conversation.beginTurn()
    const reopened = reopen()
    expect(reopened.interruptRunningTurn('restarted')).toMatchObject({ status: 'interrupted', error: 'restarted' })
    const again = reopened.beginTurn()
    expect(again?.items).toMatchObject([{ source: 'user:a', interruptedDeliveries: 1 }])
  })
})

describe('renderInbox', () => {
  it('puts user messages first, then worker events with an excerpt and a redelivery note', () => {
    const base = { receivedAt: '', leaderTurnId: 1 }
    const text = renderInbox([
      {
        ...base,
        id: 2,
        kind: 'worker_turn_ended',
        source: 'worker:w1:1',
        body: workerEvent({ output: 'x'.repeat(2000) }),
        interruptedDeliveries: 0,
      },
      { ...base, id: 1, kind: 'user_message', source: 'user:a', body: { text: 'Status?' }, interruptedDeliveries: 1 },
    ])
    expect(text.startsWith('Status?\n\n[moxy] Worker w1 "Fix the bug" (task t1) finished turn 1.')).toBe(true)
    expect(text).toContain(`${'x'.repeat(1500)}…\nRead it in full with result w1.`)
    expect(text).toContain('Your last turn was interrupted')
  })
})

describe('LeaderLoop', () => {
  it('answers a message and keeps the native session for the next turn', async () => {
    const { leader, loop, conversation, ended } = await setup()
    conversation.receive(userMessage('Hello', 'a'))
    loop.wake()
    await leader.started(1)
    expect(leader.requests[0]).toMatchObject({
      engine: 'claude',
      systemPrompt: 'Leader prompt for claude',
      message: 'Hello',
      cwd: '/work',
      nativeSessionId: null,
    })
    leader.reply({ output: 'Hi!', error: null, nativeSessionId: 'native-1' })
    await loop.idle()

    expect(ended).toMatchObject([{ status: 'finished', output: 'Hi!' }])
    expect(conversation.leader().nativeSessionId).toBe('native-1')
    expect(conversation.conversation()).toMatchObject([
      { type: 'user', text: 'Hello', leaderTurnId: ended[0]?.id },
      { type: 'moxy', turn: { output: 'Hi!' } },
    ])
  })

  it('batches what arrives during a turn into the next one', async () => {
    const { leader, loop, conversation } = await setup()
    conversation.receive(userMessage('first', 'a'))
    loop.wake()
    await leader.started(1)
    conversation.receive(userMessage('second', 'b'))
    loop.wake()
    conversation.receive(userMessage('third', 'c'))
    loop.wake()
    leader.reply({ output: 'ok', error: null, nativeSessionId: null })
    await leader.started(2)
    expect(leader.requests[1]?.message).toBe('second\n\nthird')
    leader.reply({ output: 'ok', error: null, nativeSessionId: null })
    await loop.idle()
  })

  it('records a failed turn when no runner can lead', async () => {
    const { conversation, ended } = await setup()
    const loop = new LeaderLoop({
      conversation,
      runners: () => {
        throw new Error('Cursor cannot lead Moxy')
      },
      mcp: { url: '', token: '' },
      cwd: '/work',
      systemPrompt: async engine => `Leader prompt for ${engine}`,
      timeoutMs: 1000,
      log: silentLog,
      onTurnEnded: turn => ended.push(turn),
    })
    conversation.receive(userMessage('Hello', 'a'))
    loop.wake()
    await loop.idle()
    expect(ended).toMatchObject([{ status: 'failed', error: 'Cursor cannot lead Moxy' }])
  })

  it('interrupts the running turn on close and leaves its messages for the next start', async () => {
    const { leader, loop, conversation, ended } = await setup()
    conversation.receive(userMessage('Hello', 'a'))
    loop.wake()
    await leader.started(1)
    await loop.close()

    expect(leader.stopped).toBe(1)
    expect(ended).toMatchObject([{ status: 'interrupted', error: 'Moxy stopped during this turn' }])
    expect(conversation.beginTurn()?.items).toMatchObject([{ source: 'user:a', interruptedDeliveries: 1 }])
  })

  it('stops the running turn without running its messages again, then answers what was queued', async () => {
    const { leader, loop, conversation, ended } = await setup()
    conversation.receive(userMessage('Hello', 'a'))
    loop.wake()
    await leader.started(1)
    conversation.receive(userMessage('Later', 'b'))
    expect(await loop.stop()).toBe(true)
    await leader.started(2)

    expect(ended[0]).toMatchObject({ status: 'stopped', error: 'Stopped by the user' })
    expect(leader.requests[1]?.message).toBe('Later')
    leader.reply({ output: 'ok', error: null, nativeSessionId: null })
    await loop.idle()
    expect(await loop.stop()).toBe(false)
  })

  it('sends queued messages now by interrupting the turn and answering everything together', async () => {
    const { leader, loop, conversation, ended } = await setup()
    conversation.receive(userMessage('Hello', 'a'))
    loop.wake()
    await leader.started(1)
    conversation.receive(userMessage('Actually, this first', 'b'))
    expect(await loop.sendNow()).toBe(true)
    await leader.started(2)

    expect(ended[0]).toMatchObject({ status: 'interrupted' })
    expect(leader.requests[1]?.message).toContain('Hello\n\nActually, this first')
    leader.reply({ output: 'ok', error: null, nativeSessionId: null })
    await loop.idle()
  })

  it('retries a failed turn once and hides it from then on', async () => {
    const { leader, loop, conversation, ended } = await setup()
    conversation.receive(userMessage('Hello', 'a'))
    loop.wake()
    await leader.started(1)
    leader.reply({ output: '', error: 'usage limit reached', nativeSessionId: null })
    await loop.idle()
    const failed = ended[0]!
    expect(failed).toMatchObject({ status: 'failed', retried: false })

    expect(conversation.retryTurn(failed.id)).toMatchObject({ retried: true })
    expect(() => conversation.retryTurn(failed.id)).toThrow('already retried')
    loop.wake()
    await leader.started(2)
    expect(leader.requests[1]?.message).toBe('Hello')
    leader.reply({ output: 'Hi!', error: null, nativeSessionId: null })
    await loop.idle()
    expect(conversation.conversation()).toMatchObject([
      { type: 'user', text: 'Hello', leaderTurnId: ended[1]?.id },
      { type: 'moxy', turn: { id: failed.id, retried: true } },
      { type: 'moxy', turn: { output: 'Hi!' } },
    ])
  })
})
