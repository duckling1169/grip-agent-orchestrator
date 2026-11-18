// The verdict case is copied from duckling1169/agent-usage `hooks/logic.test.ts`; the rest is new.
import { describe, expect, it } from 'vitest'

import { agoText, durationText, untilText, verdict, windowLevel } from './usage.js'

const NOW = Date.parse('2026-11-17T22:00:00Z')
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()

describe('quota wording', () => {
  it('the verdict names the tightest fresh window and ignores stale ones', () => {
    const v = verdict(
      [
        { provider: 'codex', windows: [{ name: '5h', usedPercent: 85, resetsAt: null, stale: false, observedAt: null }] },
        { provider: 'agy', windows: [{ name: '5h', usedPercent: 99, resetsAt: null, stale: true, observedAt: null }] },
      ],
      NOW,
    )
    expect(v).toEqual({ text: 'Codex is running low (15% left)', tone: 'warn' })
  })

  it('says when an exhausted provider comes back, and when all is well', () => {
    const out = [
      { provider: 'agy' as const, windows: [{ name: 'week', usedPercent: 98, resetsAt: at(3 * 1440), stale: false, observedAt: null }] },
    ]
    expect(verdict(out, NOW)).toEqual({ text: 'Antigravity is out, back in 3 d', tone: 'alert' })
    const fine = [
      { provider: 'claude' as const, windows: [{ name: '5h', usedPercent: 10, resetsAt: null, stale: false, observedAt: null }] },
    ]
    expect(verdict(fine, NOW)).toEqual({ text: 'Plenty of room everywhere', tone: 'quiet' })
  })

  it('words levels and times', () => {
    expect([windowLevel(3), windowLevel(15), windowLevel(60)]).toEqual(['alert', 'warn', 'normal'])
    expect([untilText(at(-1), NOW), untilText(at(45), NOW), untilText(at(300), NOW), untilText(null, NOW)]).toEqual([
      'reset due',
      'in 45 min',
      'in 5 h',
      '',
    ])
    expect([agoText(at(0), NOW), agoText(at(-30), NOW), agoText(null, NOW)]).toEqual(['just now', '30 min ago', 'unknown'])
    expect([durationText(5), durationText(125)]).toEqual(['5 min', '2 h 5 min'])
  })
})
