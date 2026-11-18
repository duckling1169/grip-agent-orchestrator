import { expect, it } from 'vitest'

import { afterText, errorText } from './errors.js'

it('keeps the code and each cause of an error', () => {
  const cause = Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' })
  expect(errorText(new TypeError('fetch failed', { cause }))).toBe('fetch failed: Headers Timeout Error (UND_ERR_HEADERS_TIMEOUT)')
  expect(errorText(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }))).toBe(
    'connect ECONNREFUSED 127.0.0.1:9',
  )
  expect(errorText('plain')).toBe('plain')
})

it('says how long something took', () => {
  expect(afterText(0, 42_000)).toBe('after 42 s')
  expect(afterText(0, 305_000)).toBe('after 5 min')
})
