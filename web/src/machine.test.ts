import { expect, it } from 'vitest'

import { apiUrl, baseName, normalizeBase } from './machine.js'

const here = 'https://windows-pc.tail.ts.net'

it('keeps another machine as its origin and drops this one', () => {
  expect(normalizeBase('https://linux-box.tail.ts.net/', here)).toBe('https://linux-box.tail.ts.net')
  expect(normalizeBase('https://linux-box.tail.ts.net/some/path', here)).toBe('https://linux-box.tail.ts.net')
  expect(normalizeBase(`${here}/`, here)).toBeNull()
  expect(normalizeBase(null, here)).toBeNull()
  expect(normalizeBase('', here)).toBeNull()
  expect(normalizeBase('not a url', here)).toBeNull()
})

it('builds request URLs on the chosen machine', () => {
  expect(apiUrl('/api/state', null)).toBe('/api/state')
  expect(apiUrl('/api/folders?path=C%3A', 'https://linux-box.tail.ts.net')).toBe('https://linux-box.tail.ts.net/api/folders?path=C%3A')
  expect(apiUrl('/api/events', 'http://localhost:18800')).toBe('http://localhost:18800/api/events')
})

it('names a machine from its address', () => {
  expect(baseName('https://linux-box.tail.ts.net')).toBe('linux-box')
  expect(baseName('http://localhost:18800')).toBe('localhost')
})
