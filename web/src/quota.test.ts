import { expect, it } from 'vitest'

import { pickQuotaWindows, QUOTA_WINDOWS, resetText } from './quota.js'

const reading = { usedPercent: 10, resetsAt: null, stale: false, observedAt: null }

it('selects the named five-hour and weekly readings regardless of reported order', () => {
  const fiveHour = { ...reading, name: '5h' }
  const week = { ...reading, name: 'week', usedPercent: 70 }
  const windows = [{ ...reading, name: '3p-week' }, week, { ...reading, name: 'argon' }, fiveHour]

  expect(QUOTA_WINDOWS.map(name => pickQuotaWindows(windows)[name])).toEqual([fiveHour, week])
})

it('leaves either window empty when that reading is unavailable', () => {
  const week = { ...reading, name: 'week' }
  expect(pickQuotaWindows([week, { ...reading, name: '3p-5h' }])).toEqual({ '5h': undefined, week })
  expect(pickQuotaWindows()).toEqual({ '5h': undefined, week: undefined })
})

it('says when a window resets in a few characters', () => {
  const now = Date.parse('2026-11-18T12:00:00Z')
  const at = (minutes: number) => new Date(now + minutes * 60000).toISOString()
  expect([at(45), at(119), at(240), at(6 * 1440), at(-5)].map(iso => resetText(iso, now))).toEqual(['45m', '119m', '4h', '6d', 'now'])
  expect([resetText(null, now), resetText('not a date', now)]).toEqual(['', ''])
})
