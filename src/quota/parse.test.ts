import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { jsonValues, parseAgyUsage, parseClaudeRateLimit, parseCodexRateLimits } from './parse.js'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const AT = '2026-11-17T22:00:00.000Z'

describe('Codex rateLimits/read', () => {
  it('names primary and secondary by their length and reads resetsAt as Unix seconds', () => {
    const usage = parseCodexRateLimits(JSON.parse(fixture('codex-rate-limits.json')), AT)
    expect(usage).toEqual({
      provider: 'codex',
      windows: [
        { name: '5h', usedPercent: 2, resetsAt: '2026-11-18T05:03:24.000Z', stale: false, observedAt: AT },
        { name: 'week', usedPercent: 61, resetsAt: '2026-11-23T15:31:24.000Z', stale: false, observedAt: AT },
      ],
    })
  })

  it('reads the snapshot inside an account/rateLimits/updated notification', () => {
    const usage = parseCodexRateLimits(
      { rateLimits: { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1794978204 }, secondary: null } },
      AT,
    )
    expect(usage?.windows.map(w => [w.name, w.usedPercent])).toEqual([['5h', 40]])
  })

  it('skips other limits, unknown lengths and bad percentages', () => {
    expect(
      parseCodexRateLimits({ rateLimits: { limitId: 'other', primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1 } } }, AT),
    ).toBeNull()
    const usage = parseCodexRateLimits(
      {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 140, windowDurationMins: 300, resetsAt: 1794978204 },
          secondary: { usedPercent: 10, windowDurationMins: 60, resetsAt: 1794978204 },
        },
      },
      AT,
    )
    expect(usage).toBeNull()
    expect(parseCodexRateLimits(null, AT)).toBeNull()
  })
})

describe('agy /usage', () => {
  it('turns the fraction left into percent used, for every known bucket', () => {
    const usage = parseAgyUsage(fixture('agy-usage.json'), AT)
    expect(usage?.provider).toBe('agy')
    expect(usage?.windows.map(w => [w.name, Math.round(w.usedPercent * 10) / 10, w.resetsAt])).toEqual([
      ['week', 7.5, '2026-11-25T00:14:11.000Z'],
      ['5h', 25.9, '2026-11-18T05:14:11.000Z'],
      ['3p-week', 0, '2026-11-25T01:55:26.000Z'],
      ['3p-5h', 0, '2026-11-18T06:55:26.000Z'],
      ['argon', 0.2, '2026-11-25T01:47:05.000Z'],
    ])
  })

  it('ignores a reply that is not the usage command', () => {
    expect(parseAgyUsage(JSON.stringify({ status: 'SUCCESS', response: 'It looks like you typed /usage…' }), AT)).toBeNull()
    expect(parseAgyUsage('not json', AT)).toBeNull()
  })
})

describe('Claude rate_limit_event', () => {
  it('reads the 5h, week and opus windows from stream-json', () => {
    const usage = parseClaudeRateLimit(fixture('claude-stream.jsonl'), AT)
    expect(usage?.windows.map(w => [w.name, w.usedPercent, w.resetsAt])).toEqual([
      ['5h', 23, '2026-11-18T05:03:24.000Z'],
      ['week', 47, '2026-11-23T00:40:00.000Z'],
      ['opus', 12, '2026-11-23T00:40:00.000Z'],
    ])
  })

  it('uses the last event, and none means no reading', () => {
    const event = (u: number) =>
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { unifiedWindows: { five_hour: { utilization: u, resetsAt: 1794978204 } } },
      })
    expect(parseClaudeRateLimit(`${event(0.1)}\n${event(0.9)}\n`, AT)?.windows[0]?.usedPercent).toBe(90)
    expect(parseClaudeRateLimit('{"type":"result","result":"OK"}\n', AT)).toBeNull()
  })
})

describe('jsonValues', () => {
  it('takes one document, an array, or JSON lines with junk between', () => {
    expect(jsonValues('{"a":1}')).toEqual([{ a: 1 }])
    expect(jsonValues('[1,2]')).toEqual([1, 2])
    expect(jsonValues('{"a":1}\nwarning: x\r\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }])
  })
})
