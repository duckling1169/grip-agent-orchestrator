import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { protectedFolderOf } from './folders.js'

describe('protectedFolderOf', () => {
  const guarded = join('/home', 'me', '.ssh')

  it('names the protected folder a path is in or is', () => {
    expect(protectedFolderOf(guarded, [guarded])).toBe(guarded)
    expect(protectedFolderOf(join(guarded, 'keys'), [guarded])).toBe(guarded)
  })

  it('allows siblings that only share a prefix', () => {
    expect(protectedFolderOf(join('/home', 'me', '.ssh-notes'), [guarded])).toBeNull()
    expect(protectedFolderOf(join('/home', 'me'), [guarded])).toBeNull()
  })
})
