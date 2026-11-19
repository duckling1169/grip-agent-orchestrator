import { describe, expect, it } from 'vitest'

import type { ConversationEntry, Task } from '../contracts/api.js'
import { handoffContext } from './context.js'

const memory = { instructions: 'SECRET STANDING INSTRUCTION', preferences: 'Use focused tests', updatedAt: '2026-11-19T12:00:00Z' }
const task = (id: string, update: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  repoRoot: 'C:/repos/moxy',
  status: 'working',
  plan: 'Keep changes focused',
  notes: 'Feedback: fix mobile layout',
  testing: 'Run fake-backed preview',
  revision: null,
  howToTry: null,
  supersededBy: null,
  createdAt: '2026-11-19T12:00:00Z',
  updatedAt: '2026-11-19T12:00:00Z',
  ...update,
})
const user = (id: number, text: string, turn: number | null = id): ConversationEntry => ({
  type: 'user',
  inboxId: id,
  source: `user:${id}`,
  text,
  leaderTurnId: turn,
  at: '2026-11-19T12:00:00Z',
})
const reply = (id: number, output: string): ConversationEntry => ({
  type: 'moxy',
  turn: {
    id,
    engine: 'claude',
    model: 'sonnet',
    effort: 'high',
    status: 'finished',
    output,
    error: null,
    recovery: null,
    startedAt: '2026-11-19T12:00:00Z',
    endedAt: '2026-11-19T12:01:00Z',
    retried: false,
  },
})

describe('handoffContext', () => {
  it('preserves open task pointers, plans, feedback, testing conventions and user preferences', () => {
    const context = handoffContext(
      {
        tasks: [task('working'), task('waiting', { status: 'waiting' }), task('closed', { status: 'done', notes: 'DONE TASK DETAILS' })],
        conversation: [],
        memory,
      },
      3,
    )
    for (const text of [
      'working',
      'waiting',
      'C:/repos/moxy',
      'Keep changes focused',
      'Feedback: fix mobile layout',
      'Run fake-backed preview',
      'Use focused tests',
      'task_get',
    ])
      expect(context).toContain(text)
    expect(context).not.toContain('DONE TASK DETAILS')
    expect(context).not.toContain('SECRET STANDING INSTRUCTION')
  })

  it('seeds historical conversation without duplicating the current inbox or queued user input', () => {
    const running = reply(5, 'CURRENT RUNNING OUTPUT')
    if (running.type === 'moxy') running.turn.status = 'running'
    const context = handoffContext(
      {
        tasks: [],
        memory,
        conversation: [
          user(1, 'Past request'),
          reply(1, 'Past response'),
          user(2, 'CURRENT INPUT', 5),
          running,
          user(3, 'PENDING INPUT', null),
          user(4, 'FUTURE INPUT', 6),
        ],
      },
      5,
    )
    expect(context).toContain('Past request')
    expect(context).toContain('Past response')
    for (const text of ['CURRENT INPUT', 'CURRENT RUNNING OUTPUT', 'PENDING INPUT', 'FUTURE INPUT']) expect(context).not.toContain(text)
    expect(context).toContain('historical context')
    expect(context).toContain('Current inbox')
  })

  it('bounds tasks, history, preferences and individual messages with explicit clipping notices', () => {
    const tasks = Array.from({ length: 40 }, (_, i) =>
      task(`task-${i}`, {
        plan: 'plan'.repeat(5000),
        notes: `${'old notes '.repeat(5000)}Feedback: preserve recent correction`,
        testing: 'testing'.repeat(5000),
      }),
    )
    const conversation = Array.from({ length: 40 }, (_, i) => user(i, `message-${i} ${'text'.repeat(5000)}`, i))
    const context = handoffContext({ tasks, conversation, memory: { ...memory, preferences: 'preferences '.repeat(5000) } }, 50)
    expect(context.length).toBeLessThan(40000)
    expect(context).toContain('clipped')
    expect(context).toContain('task_get')
    expect(context).toContain('message-39')
    expect(context).not.toContain('message-0 ')
    expect(context).not.toContain('task-30')
    expect(context).toContain('Feedback: preserve recent correction')
    expect(context).not.toContain('text'.repeat(501))
  })

  it('does not mutate supplied task and conversation records', () => {
    const tasks = [task('one')]
    const conversation = [user(1, 'One'), reply(1, 'Two')]
    const before = JSON.stringify({ tasks, conversation, memory })
    handoffContext({ tasks, conversation, memory }, 3)
    expect(JSON.stringify({ tasks, conversation, memory })).toBe(before)
  })

  it('keeps oversized model labels and task pointers inside the seed budget', () => {
    const historical = reply(1, 'assistant message '.repeat(5000))
    if (historical.type === 'moxy') historical.turn.model = 'model'.repeat(20000)
    const context = handoffContext(
      { tasks: [task('oversized', { repoRoot: 'repo'.repeat(20000) })], conversation: [historical], memory },
      2,
    )
    expect(context.length).toBeLessThan(40000)
    expect(context).toContain('clipped')
  })
})
