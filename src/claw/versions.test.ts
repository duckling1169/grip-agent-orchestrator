import { describe, expect, it } from 'vitest'

import { inRange, isNewer, pendingMajor, pickTarget } from './versions.js'

const published = ['7.22.0', '7.23.3', '7.23.4', '7.24.0-beta.1', '7.24.0', '7.25.1', '8.0.0', '8.1.0']

describe('pickTarget', () => {
  it('takes the newest release inside the range and skips prereleases', () => {
    expect(pickTarget(published)).toBe('7.25.1')
    expect(pickTarget(['7.23.4', '7.26.0-rc.1'])).toBe('7.23.4')
  })
  it('returns null when nothing qualifies', () => {
    expect(pickTarget(['7.22.0', '8.0.0'])).toBeNull()
  })
})

describe('pendingMajor', () => {
  it('reports the newest release above the cap', () => {
    expect(pendingMajor(published)).toBe('8.1.0')
    expect(pendingMajor(['7.23.4', '7.25.1'])).toBeNull()
  })
})

describe('inRange / isNewer', () => {
  it('accepts only valid versions in range', () => {
    expect(inRange('7.23.4')).toBe(true)
    expect(inRange('7.23.3')).toBe(false)
    expect(inRange('8.0.0')).toBe(false)
    expect(inRange(null)).toBe(false)
    expect(inRange('garbage')).toBe(false)
  })
  it('treats a missing current version as older', () => {
    expect(isNewer('7.24.0', null)).toBe(true)
    expect(isNewer('7.24.0', '7.24.0')).toBe(false)
  })
})
