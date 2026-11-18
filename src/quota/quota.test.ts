import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { Quota } from './quota.js'
import type { QuotaReaders } from './readers.js'
import type { ProviderUsage, ToolId } from './usage.js'

const T0 = Date.parse('2026-11-17T22:00:00Z')
const HOUR = 3600_000
const iso = (ms: number) => new Date(ms).toISOString()

const cleanups: string[] = []
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

const reading = (provider: ToolId, used: number, resetsAt = iso(T0 + 2 * HOUR)): ProviderUsage => ({
  provider,
  windows: [{ name: '5h', usedPercent: used, resetsAt, stale: false, observedAt: iso(T0) }],
})

/** Readers that answer from a table the test changes, counting each call. */
function fakeReaders() {
  const answers: Partial<Record<ToolId, ProviderUsage | null | Error>> = {}
  const calls: ToolId[] = []
  const read = (p: ToolId) => async () => {
    calls.push(p)
    const a = answers[p]
    if (a instanceof Error) throw a
    return a ?? null
  }
  const readers: QuotaReaders = { codex: read('codex'), agy: read('agy'), claude: read('claude') }
  return { readers, answers, calls }
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'grip-quota-test-'))
  cleanups.push(dir)
  const clock = { now: T0 }
  const fake = fakeReaders()
  const path = join(dir, 'quota.json')
  const open = () => Quota.open({ path, readers: fake.readers, now: () => clock.now })
  return { ...fake, clock, path, open, quota: await open() }
}

describe('Quota', () => {
  it('starts empty and refreshes only the free providers by default', async () => {
    const { quota, answers, calls } = await setup()
    expect(quota.snapshot().verdict.text).toBe('Waiting for a reading')
    answers.codex = reading('codex', 85)
    answers.agy = reading('agy', 10)
    const snap = await quota.refresh()
    expect(calls.sort()).toEqual(['agy', 'codex'])
    expect(snap.verdict).toEqual({ text: 'Codex is running low (15% left)', tone: 'warn' })
    expect(snap.providers.find(p => p.provider === 'claude')).toMatchObject({ windows: [], checkedAt: null })
  })

  it('reads Claude only when asked by name', async () => {
    const { quota, answers, calls } = await setup()
    answers.claude = reading('claude', 97)
    await quota.refresh(['claude'])
    expect(calls).toEqual(['claude'])
    expect(quota.snapshot().verdict.text).toBe('Claude is out, back in 2 h')
  })

  it('reads every provider, Claude included, on its timer', async () => {
    vi.useFakeTimers()
    try {
      const { quota, calls } = await setup()
      quota.startTimer(5 * 60_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(calls.sort()).toEqual(['agy', 'claude', 'codex'])
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(calls).toHaveLength(6)
      quota.stopTimer()
      await vi.advanceTimersByTimeAsync(15 * 60_000)
      expect(calls).toHaveLength(6)
      quota.startTimer(0)
      await vi.advanceTimersByTimeAsync(15 * 60_000)
      expect(calls).toHaveLength(6)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the last good reading beside a failure', async () => {
    const { quota, answers } = await setup()
    answers.agy = reading('agy', 30)
    await quota.refresh(['agy'])
    answers.agy = new Error('agy /usage: not signed in')
    const agy = (await quota.refresh(['agy'])).providers.find(p => p.provider === 'agy')
    expect(agy).toMatchObject({ error: 'agy /usage: not signed in', windows: [{ usedPercent: 30 }] })
    answers.agy = null
    const empty = (await quota.refresh(['agy'])).providers.find(p => p.provider === 'agy')
    expect(empty).toMatchObject({ error: 'Antigravity reported no quota windows', windows: [{ usedPercent: 30 }] })
  })

  it('shows a window past its reset as 0% and stale', async () => {
    const { quota, answers, clock } = await setup()
    answers.codex = reading('codex', 99)
    await quota.refresh(['codex'])
    clock.now = T0 + 3 * HOUR
    const snap = quota.snapshot()
    expect(snap.providers[0]?.windows[0]).toMatchObject({ usedPercent: 0, stale: true })
    expect(snap.verdict.text).toBe('Waiting for a reading')
  })

  it('reads again after worker turns, at most once a minute, and never probes Claude', async () => {
    const { quota, calls, clock } = await setup()
    const settle = () => new Promise(r => setTimeout(r, 20))
    quota.afterTurn('codex')
    await settle()
    quota.afterTurn('codex')
    quota.afterTurn('claude')
    clock.now += 61_000
    quota.afterTurn('codex')
    await settle()
    expect(calls).toEqual(['codex', 'codex'])
  })

  it('shares one read between callers that overlap', async () => {
    const { quota, calls } = await setup()
    await Promise.all([quota.refresh(['agy']), quota.refresh(['agy'])])
    expect(calls).toEqual(['agy'])
  })

  it('notes only a low or out provider, for delegate', async () => {
    const { quota, answers } = await setup()
    answers.codex = reading('codex', 82)
    answers.agy = reading('agy', 40)
    await quota.refresh()
    expect(quota.noteFor('codex')).toBe('Codex is running low (18% left)')
    expect(quota.noteFor('agy')).toBeNull()
    expect(quota.noteFor('claude')).toBeNull()
  })

  it('saves readings, so a restart shows them at once', async () => {
    const { quota, answers, path, open } = await setup()
    answers.codex = reading('codex', 50)
    await quota.refresh(['codex'])
    expect(JSON.parse(await readFile(path, 'utf8')).providers.codex.windows[0].usedPercent).toBe(50)
    const again = await open()
    expect(again.snapshot().providers[0]).toMatchObject({ provider: 'codex', windows: [{ usedPercent: 50 }], checkedAt: iso(T0) })
  })

  it('tells listeners when a read starts and ends', async () => {
    const { quota } = await setup()
    const busy: boolean[] = []
    quota.on('change', s => busy.push(s.providers.find(p => p.provider === 'agy')!.busy))
    await quota.refresh(['agy'])
    expect(busy).toEqual([true, false])
  })
})
