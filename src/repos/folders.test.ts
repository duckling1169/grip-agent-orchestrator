import { mkdir, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { temporaryHome } from '../testing/harness.js'
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

  it('guards the real directory when the protected path uses an alias', async () => {
    const home = await temporaryHome()
    const target = join(home, 'data')
    const alias = join(home, 'protected')
    await mkdir(join(target, 'inside'), { recursive: true })
    await symlink(target, alias, 'junction')
    const inside = await realpath(join(alias, 'inside'))
    expect(protectedFolderOf(inside, [alias])).toBe(alias)
  })
})
