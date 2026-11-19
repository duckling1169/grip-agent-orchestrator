import { describe, expect, it } from 'vitest'

import type { EngineQuota } from '../contracts/api.js'
import type { Engine } from '../contracts/engines.js'
import { recoveryFor } from './recovery.js'

const RESET = '2099-11-19T12:00:00.000Z'
const quota = (engine: Engine, usedPercent: number, overrides: Partial<EngineQuota> = {}): EngineQuota => ({
  engine,
  checkedAt: '2099-11-19T11:00:00.000Z',
  error: null,
  busy: false,
  windows: [{ name: '5h', usedPercent, stale: false, resetsAt: RESET, observedAt: '2099-11-19T11:00:00.000Z' }],
  ...overrides,
})

describe('provider recovery', () => {
  it.each([
    'rate_limit_exceeded',
    'HTTP 429: Too Many Requests',
    'You have hit your usage limit',
    'usage_limit_reached',
    'usageLimitExceeded',
    "You've hit your limit",
    'quota exhausted',
    'insufficient_quota',
    'RESOURCE_EXHAUSTED',
  ])('classifies official provider exhaustion errors: %s', error => {
    expect(recoveryFor('codex', error, [quota('claude', 30)], () => true)).toEqual({
      provider: 'codex',
      resetsAt: null,
      suggested: { engine: 'claude', model: null, effort: null },
      reason: error,
    })
  })

  it.each([
    'the model refused to continue',
    'the reply reached its token limit',
    'context length exceeded',
    'File not found',
    'stopped',
    'HTTP 401: Unauthorized',
  ])('does not suggest quota recovery for other failures: %s', error => {
    expect(recoveryFor('codex', error, [], () => true)).toBeNull()
  })

  it('uses only fresh exhausted windows and waits for every exhausted window to reset', () => {
    const exhausted = quota('codex', 100)
    exhausted.windows.push({ ...exhausted.windows[0]!, name: 'week', resetsAt: '2099-11-25T12:00:00.000Z' })
    expect(recoveryFor('codex', null, [exhausted], () => false)).toMatchObject({
      provider: 'codex',
      resetsAt: '2099-11-25T12:00:00.000Z',
      suggested: null,
    })
    exhausted.windows.forEach(window => {
      window.stale = true
    })
    expect(recoveryFor('codex', null, [exhausted], () => true)).toBeNull()
    expect(recoveryFor('codex', null, [quota('codex', 100, { error: 'refresh failed' })], () => true)).toBeNull()
  })

  it('prefers known available installed leaders and falls back to installed unknown quota', () => {
    const current = quota('codex', 100)
    const claude = quota('claude', 10)
    claude.windows.push({ ...claude.windows[0]!, name: 'week', usedPercent: 100 })
    const stale = quota('agy', 10)
    stale.windows[0]!.stale = true
    expect(recoveryFor('codex', 'rate limited', [current, claude, stale, quota('cursor', 10)], () => true)?.suggested).toEqual({
      engine: 'agy',
      model: null,
      effort: null,
    })
    expect(
      recoveryFor('codex', 'rate limited', [current, quota('claude', 10), quota('agy', 20)], engine => engine !== 'claude')?.suggested,
    ).toEqual({ engine: 'agy', model: null, effort: null })
  })

  it('does not treat model-specific buckets as whole-provider exhaustion', () => {
    const claude = quota('claude', 20)
    claude.windows.push({ ...claude.windows[0]!, name: 'opus', usedPercent: 100 })
    expect(recoveryFor('claude', null, [claude], () => true)).toBeNull()
    expect(recoveryFor('codex', 'rate limited', [claude], () => true)?.suggested?.engine).toBe('claude')
  })

  it('prefers fresh known headroom over an earlier unknown provider', () => {
    expect(recoveryFor('codex', 'rate limited', [quota('agy', 20)], () => true)?.suggested?.engine).toBe('agy')
  })

  it('ignores passed reset times even if a cached flag was not updated', () => {
    const past = quota('codex', 100)
    past.windows[0]!.resetsAt = '2000-01-01T00:00:00.000Z'
    expect(recoveryFor('codex', null, [past], () => true)).toBeNull()
  })
})
