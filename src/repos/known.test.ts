import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { temporaryHome } from '../testing/harness.js'
import { knownRepos } from './known.js'

describe('known repositories', () => {
  it('finds git repositories a few levels down, without entering them, worktrees or dependencies', async () => {
    const root = await temporaryHome()
    for (const folder of [
      'app/.git',
      'app/packages/inner/.git',
      'js/site/.git',
      'js/site-worktrees/branch/.git',
      'js/node_modules/lib/.git',
      'a/b/c/too-deep/.git',
    ])
      await mkdir(join(root, folder), { recursive: true })
    expect(await knownRepos([root, join(root, 'missing')])).toEqual([join(root, 'app'), join(root, 'js', 'site')])
  })

  it('stops at the limit', async () => {
    const root = await temporaryHome()
    for (const name of ['one', 'two', 'three']) await mkdir(join(root, name, '.git'), { recursive: true })
    expect(await knownRepos([root], 2)).toHaveLength(2)
  })
})
