import { join } from 'node:path'

import { describe, expect, it, onTestFinished, vi } from 'vitest'

import { Database } from '../db/database.js'
import { MOXY_SCHEMA } from '../db/schema.js'
import { temporaryHome } from '../testing/harness.js'
import { FollowUps } from './follow-ups.js'
import { ConversationStore } from './store.js'

const START = Date.parse('2026-11-19T12:00:00Z')
const iso = (milliseconds: number) => new Date(milliseconds).toISOString()

async function setup() {
  const path = join(await temporaryHome(), 'moxy.db')
  let database = Database.open(path, MOXY_SCHEMA)
  const clock = { now: START }
  const wake = vi.fn()
  let followUps = new FollowUps(database, { wake, now: () => clock.now })
  onTestFinished(() => {
    followUps.close()
    database.close()
  })
  return {
    clock,
    wake,
    database,
    followUps,
    restart() {
      followUps.close()
      database.close()
      database = Database.open(path, MOXY_SCHEMA)
      followUps = new FollowUps(database, { wake, now: () => clock.now })
      return { followUps, database }
    },
  }
}

describe('FollowUps', () => {
  it('persists schedules and atomically delivers overdue follow-ups once after restart', async () => {
    const fixture = await setup()
    const scheduled = fixture.followUps.schedule({ dueAt: iso(START + 1000), prompt: 'Retry after reset' })
    expect(scheduled).toMatchObject({ prompt: 'Retry after reset', status: 'pending', source: `follow-up:${scheduled.id}` })
    fixture.clock.now += 2000
    const { followUps, database } = fixture.restart()
    followUps.start()
    expect(fixture.wake).toHaveBeenCalledTimes(1)
    expect(followUps.list()).toMatchObject([{ id: scheduled.id, status: 'done' }])
    expect(followUps.deliverDue()).toBe(0)
    const conversation = new ConversationStore(database)
    const turn = conversation.beginTurn()
    expect(turn?.items).toMatchObject([
      { kind: 'follow_up', source: scheduled.source, body: { id: scheduled.id, prompt: scheduled.prompt, dueAt: scheduled.dueAt } },
    ])
    const restarted = fixture.restart()
    restarted.followUps.start()
    expect(restarted.database.prepare('SELECT COUNT(*) AS count FROM inbox').get()?.count).toBe(1)
    expect(fixture.wake).toHaveBeenCalledTimes(1)
  })

  it('rolls back the inbox insert when completing a due row fails, and wakes only after commit', async () => {
    const { followUps, database, wake } = await setup()
    followUps.schedule({ dueAt: iso(START), prompt: 'Due' })
    database.prepare(`CREATE TRIGGER refuse_done BEFORE UPDATE ON follow_ups BEGIN SELECT RAISE(ABORT, 'cannot complete'); END`).run()
    expect(() => followUps.deliverDue()).toThrow('cannot complete')
    expect(database.prepare('SELECT COUNT(*) AS count FROM inbox').get()?.count).toBe(0)
    expect(followUps.list()[0]?.status).toBe('pending')
    expect(wake).not.toHaveBeenCalled()
    database.prepare('DROP TRIGGER refuse_done').run()
    wake.mockImplementation(() => {
      expect(followUps.list()[0]?.status).toBe('done')
      expect(database.prepare('SELECT COUNT(*) AS count FROM inbox').get()?.count).toBe(1)
    })
    expect(followUps.deliverDue()).toBe(1)
  })

  it('cancels only pending timers and validates prompt and timezone-qualified due times', async () => {
    const { followUps } = await setup()
    for (const dueAt of ['tomorrow', '2026-11-19T12:00:00', '2026-02-30T12:00:00Z', 'invalid'])
      expect(() => followUps.schedule({ dueAt, prompt: 'Do it' })).toThrow('dueAt')
    expect(() => followUps.schedule({ dueAt: iso(START), prompt: ' ' })).toThrow('prompt')
    expect(() => followUps.schedule({ dueAt: iso(START), prompt: 'x'.repeat(8001) })).toThrow('prompt')
    const scheduled = followUps.schedule({ dueAt: iso(START), prompt: 'Skip' })
    expect(followUps.cancel(scheduled.id).status).toBe('cancelled')
    expect(followUps.deliverDue()).toBe(0)
    expect(() => followUps.cancel('missing')).toThrow('unknown follow-up')
    const done = followUps.schedule({ dueAt: iso(START), prompt: 'Deliver' })
    followUps.deliverDue()
    expect(() => followUps.cancel(done.id)).toThrow('pending')
  })

  it('uses bounded native timers for distant dates and stops them on close', async () => {
    const { followUps, clock, wake } = await setup()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      followUps.schedule({ dueAt: iso(START + 3 * 86400000), prompt: 'Later' })
      followUps.start()
      expect(vi.getTimerCount()).toBe(1)
      clock.now += 86400000
      await vi.advanceTimersByTimeAsync(86400000)
      expect(wake).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(1)
      followUps.close()
      expect(vi.getTimerCount()).toBe(0)
      clock.now += 3 * 86400000
      await vi.advanceTimersByTimeAsync(3 * 86400000)
      expect(wake).not.toHaveBeenCalled()
      expect(() => followUps.schedule({ dueAt: iso(clock.now), prompt: 'Closed' })).toThrow('closed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rearms when an earlier follow-up is added or cancelled and delivers at its due time', async () => {
    const { followUps, clock, wake } = await setup()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      followUps.start()
      followUps.schedule({ dueAt: iso(START + 5000), prompt: 'Later' })
      const cancelled = followUps.schedule({ dueAt: iso(START + 1000), prompt: 'Cancelled earlier' })
      followUps.cancel(cancelled.id)
      clock.now += 1000
      await vi.advanceTimersByTimeAsync(1000)
      expect(wake).not.toHaveBeenCalled()
      followUps.schedule({ dueAt: iso(START + 2000), prompt: 'Earlier' })
      clock.now += 1000
      await vi.advanceTimersByTimeAsync(1000)
      expect(wake).toHaveBeenCalledTimes(1)
      expect(followUps.list().find(row => row.prompt === 'Earlier')?.status).toBe('done')
      clock.now += 3000
      await vi.advanceTimersByTimeAsync(3000)
      expect(wake).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      followUps.close()
      vi.useRealTimers()
    }
  })

  it('backs off failed timer transactions without losing the due follow-up', async () => {
    const { database, clock, wake } = await setup()
    const onError = vi.fn()
    const followUps = new FollowUps(database, { wake, now: () => clock.now, onError })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      followUps.schedule({ dueAt: iso(START), prompt: 'Retry timer delivery' })
      database
        .prepare(`CREATE TRIGGER refuse_done BEFORE UPDATE ON follow_ups BEGIN SELECT RAISE(ABORT, 'temporarily unavailable'); END`)
        .run()
      followUps.start()
      expect(onError).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(500)
      expect(onError).toHaveBeenCalledTimes(1)
      expect(wake).not.toHaveBeenCalled()
      database.prepare('DROP TRIGGER refuse_done').run()
      clock.now += 1000
      await vi.advanceTimersByTimeAsync(500)
      expect(wake).toHaveBeenCalledTimes(1)
      expect(followUps.list()[0]?.status).toBe('done')
    } finally {
      followUps.close()
      vi.useRealTimers()
    }
  })
})
