import { expect, it } from 'vitest'

import { pickQuotaWindows, QUOTA_WINDOWS } from './quota.js'

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
