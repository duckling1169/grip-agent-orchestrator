import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EngineUsage } from '../contracts/api.js'
import { Quota } from './quota.js'
import type { QuotaEngine, QuotaReaders } from './quota-readers.js'

const START = Date.parse('2026-11-17T22:00:00Z')
const cleanups: string[] = []
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'moxy-quota-test-'))
  cleanups.push(dir)
  const answers: Partial<Record<QuotaEngine, EngineUsage | Error>> = {}
  const calls: QuotaEngine[] = []
  const read = (engine: QuotaEngine) => async () => {
    calls.push(engine)
    const answer = answers[engine]
    if (answer instanceof Error) throw answer
    return answer ?? null
  }
  const readers: QuotaReaders = { codex: read('codex'), agy: read('agy'), claude: read('claude') }
  const clock = { now: START }
  const open = () => Quota.open({ path: join(dir, 'quota.json'), readers, now: () => clock.now })
  return { quota: await open(), open, readers, answers, calls, clock }
}

const reading = (engine: QuotaEngine): EngineUsage => ({
  engine,
  windows: [
    {
      name: '5h',
      usedPercent: 91,
      resetsAt: new Date(START + 3600_000).toISOString(),
      observedAt: new Date(START).toISOString(),
      stale: false,
    },
  ],
})

describe('Quota', () => {
  it('refreshes only free providers by default and deduplicates overlapping reads', async () => {
    const { quota, calls } = await setup()
    await Promise.all([quota.refresh(), quota.refresh()])
    expect(calls.sort()).toEqual(['agy', 'codex'])
    expect(quota.snapshot().find(q => q.engine === 'claude')).toMatchObject({ windows: [], checkedAt: null })
  })

  it('persists readings and preserves recorded usage as stale when resets pass or a read fails', async () => {
    const { quota, answers, clock, open } = await setup()
    answers.codex = reading('codex')
    await quota.refresh(['codex'])
    expect((await open()).snapshot()[0]?.windows[0]?.usedPercent).toBe(91)
    clock.now += 2 * 3600_000
    expect(quota.snapshot()[0]?.windows[0]).toMatchObject({ usedPercent: 91, stale: true })
    answers.codex = new Error('not signed in')
    await quota.refresh(['codex'])
    expect(quota.snapshot()[0]).toMatchObject({ error: 'not signed in', windows: [{ usedPercent: 91, stale: true }] })
  })

  it('reports empty readings and emits busy state before and after a read', async () => {
    const { quota } = await setup()
    const busy: boolean[] = []
    quota.on('change', state => busy.push(state[0]!.busy))
    await quota.refresh(['codex'])
    expect(busy).toEqual([true, false])
    expect(quota.snapshot()[0]?.error).toBe('Codex reported no quota windows')
  })

  it('refreshes all providers on its timer, can disable it, and never probes Claude after a turn', async () => {
    const { quota, calls, clock } = await setup()
    vi.useFakeTimers()
    try {
      quota.startTimer(300_000)
      await vi.advanceTimersByTimeAsync(0)
      await quota.idle()
      expect(calls).toEqual([])
      await vi.advanceTimersByTimeAsync(300_000)
      await quota.idle()
      expect(calls.sort()).toEqual(['agy', 'claude', 'codex'])
      quota.startTimer(0)
      await vi.advanceTimersByTimeAsync(300_000)
      expect(calls).toHaveLength(3)
      quota.afterTurn('claude')
      quota.afterTurn('cursor')
      quota.afterTurn('codex')
      await quota.idle()
      quota.afterTurn('codex')
      clock.now += 61_000
      quota.afterTurn('codex')
      await quota.idle()
      expect(calls.slice(3)).toEqual(['codex', 'codex'])
      await quota.close()
      quota.afterTurn('codex')
      expect(calls).toHaveLength(5)
    } finally {
      quota.stopTimer()
      vi.useRealTimers()
    }
  })
})
