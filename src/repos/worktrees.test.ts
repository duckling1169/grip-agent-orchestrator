import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { exec, execOk } from '../exec.js'
import { temporaryRepo } from '../testing/harness.js'
import { Worktrees } from './worktrees.js'

it('reports complete file summaries with decoded paths even when the patch is clipped', async () => {
  const root = await temporaryRepo()
  const git = (...args: string[]) => execOk(exec, 'git', ['-C', root, ...args]).then(output => output.trim())
  await git('config', 'core.quotePath', 'true')
  await writeFile(join(root, 'old name.txt'), 'rename me\n')
  await git('add', '.')
  await git('commit', '-qm', 'Add rename source')
  const base = await git('rev-parse', 'HEAD')
  await git('mv', 'old name.txt', 'new name.txt')
  await writeFile(join(root, 'README.md'), 'content\n'.repeat(40_000))
  await writeFile(join(root, 'résumé.txt'), 'first\nsecond\n')
  await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2]))
  await writeFile(join(root, 'large.txt'), Buffer.alloc(256 * 1024 + 1, 97))

  const worktrees = new Worktrees()
  expect((await worktrees.facts(root, base)).changedFiles).toEqual(['README.md', 'binary.dat', 'large.txt', 'new name.txt', 'résumé.txt'])
  const diff = await worktrees.diff(root, base)
  expect(diff.files).toHaveLength(5)
  expect(diff.truncated).toBe(true)
  expect(diff.files).toEqual(
    expect.arrayContaining([
      { path: 'README.md', status: 'modified', added: 40_000, removed: 1, binary: false, skipped: null },
      { path: 'new name.txt', status: 'renamed', added: 0, removed: 0, binary: false, skipped: null },
      { path: 'résumé.txt', status: 'added', added: 2, removed: 0, binary: false, skipped: null },
      { path: 'binary.dat', status: 'added', added: null, removed: null, binary: true, skipped: null },
      { path: 'large.txt', status: 'added', added: null, removed: null, binary: null, skipped: 'larger than 256 KiB' },
    ]),
  )
})
