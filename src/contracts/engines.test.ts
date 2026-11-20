import { describe, expect, it } from 'vitest'
import { modelFamily, sharedFamily } from './engines.js'

describe('modelFamily', () => {
  it('names the family of a model that another engine runs', () => {
    expect(modelFamily('agy', 'claude-sonnet-5-5')).toBe('claude')
    expect(modelFamily('agy', 'gemini-4-hydrogen')).toBe('gemini')
    expect(modelFamily('opencode', 'openai/gpt-5.5')).toBe('gpt')
  })

  it('falls back to the engine family for unknown or missing models', () => {
    expect(modelFamily('claude', 'opus')).toBe('claude')
    expect(modelFamily('agy', null)).toBe('gemini')
    expect(modelFamily('cursor', 'composer-2')).toBe('cursor')
  })
})

describe('sharedFamily', () => {
  it('returns the one family that all runs share', () => {
    expect(
      sharedFamily([
        { engine: 'claude', model: 'opus' },
        { engine: 'agy', model: 'claude-sonnet-5-5' },
      ]),
    ).toBe('claude')
  })

  it('reports mixed families and no runs', () => {
    expect(
      sharedFamily([
        { engine: 'agy', model: 'gemini-4-hydrogen' },
        { engine: 'agy', model: 'claude-sonnet-5-5' },
      ]),
    ).toBe('mixed')
    expect(sharedFamily([])).toBeNull()
  })
})
