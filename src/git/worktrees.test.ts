import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { parseStatusFiles, parseWorktreeList, slugify } from './parse.js'
import { diskUsage, overlappingFiles, samePath, Worktrees } from './worktrees.js'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=grip-test', '-c', 'user.email=grip@test', '-C', cwd, ...args], { encoding: 'utf8' }).trim()

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function repo(): Promise<string> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'grip-wt-')))
  dirs.push(parent)
  const root = join(parent, 'app')
  await mkdir(join(root, 'src'), { recursive: true })
  git(parent, 'init', '-q', '-b', 'main', root)
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  await writeFile(join(root, 'README.md'), 'app\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'init')
  return root
}

const wt = new Worktrees()

describe('repoOf', () => {
  it('finds the main checkout from a subfolder and from inside a worktree', async () => {
    const root = await repo()
    expect(await wt.repoOf(join(root, 'src'))).toEqual({ root, base: 'main' })
    const made = await wt.create({ root, base: 'main' }, 'codex', 'Fix login')
    expect(await wt.repoOf(made.path)).toEqual({ root, base: 'main' })
  })

  it('returns null outside a repo', async () => {
    const plain = await realpath(await mkdtemp(join(tmpdir(), 'grip-plain-')))
    dirs.push(plain)
    expect(await wt.repoOf(plain)).toBeNull()
  })
})

describe('create', () => {
  it('makes a sibling worktree on a grip/ branch and numbers clashes', async () => {
    const root = await repo()
    const r = { root, base: 'main' }
    const first = await wt.create(r, 'codex', 'Fix the login bug!')
    expect(samePath(first.path, join(`${root}-worktrees`, 'codex-fix-the-login-bug'))).toBe(true)
    expect(first.branch).toBe('grip/codex-fix-the-login-bug')
    expect(first.baseCommit).toBe(git(root, 'rev-parse', 'HEAD'))
    const second = await wt.create(r, 'codex', 'Fix the login bug!')
    expect(second.branch).toBe('grip/codex-fix-the-login-bug-2')
    // Nothing appears inside the repo itself.
    expect(git(root, 'status', '--porcelain')).toBe('')
  })
})

describe('facts and diff', () => {
  it('reports commits, uncommitted edits and untracked files against the start commit', async () => {
    const root = await repo()
    const made = await wt.create({ root, base: 'main' }, 'claude', 'Add b')
    const fresh = await wt.facts(made.path, made.baseCommit)
    expect(fresh).toMatchObject({ branch: made.branch, ahead: 0, changedFiles: [], lastCommit: null, newestEdit: null })

    await writeFile(join(made.path, 'src', 'b.ts'), 'export const b = 2\n')
    git(made.path, 'add', '.')
    git(made.path, 'commit', '-qm', 'Add b')
    await writeFile(join(made.path, 'src', 'a.ts'), 'export const a = 3\n')
    await writeFile(join(made.path, 'notes.txt'), 'scratch\n')

    const facts = await wt.facts(made.path, made.baseCommit)
    expect(facts.ahead).toBe(1)
    expect(facts.lastCommit?.subject).toBe('Add b')
    expect(facts.changedFiles).toEqual(['notes.txt', 'src/a.ts', 'src/b.ts'])
    expect(facts.untrackedFiles).toEqual(['notes.txt'])
    expect(facts.newestEdit?.file).toMatch(/notes\.txt|src\/a\.ts/)

    const diff = await wt.diff(made.path, made.baseCommit)
    expect(diff.patch).toContain('+export const b = 2')
    expect(diff.patch).toContain('+export const a = 3')
    expect(diff.stat).toContain('2 files changed')
    expect(diff.untrackedFiles).toEqual(['notes.txt'])
    // A new file the worker did not commit shows in full, and the worktree's index stays as it was.
    expect(diff.patch).toMatch(/diff --git a\/notes\.txt b\/notes\.txt\nnew file mode \d+\n[^]*\+scratch/)
    expect(git(made.path, 'status', '--porcelain')).toContain('?? notes.txt')
  })
})

describe('merged', () => {
  it('counts a worktree as merged only when it is clean and its branch is in the base', async () => {
    const root = await repo()
    const made = await wt.create({ root, base: 'main' }, 'claude', 'Small fix')
    expect(await wt.merged(made.path, 'main')).toBe(true)
    await writeFile(join(made.path, 'fix.txt'), 'fix\n')
    expect(await wt.merged(made.path, 'main')).toBe(false)
    git(made.path, 'add', '.')
    git(made.path, 'commit', '-qm', 'Fix')
    expect(await wt.merged(made.path, 'main')).toBe(false)
    git(root, 'merge', '-q', made.branch)
    expect(await wt.merged(made.path, 'main')).toBe(true)
  })
})

describe('list and remove', () => {
  it('lists only Grip worktrees, and keeps a branch with unmerged commits', async () => {
    const root = await repo()
    const r = { root, base: 'main' }
    git(root, 'worktree', 'add', '-q', '-b', 'someone-else', join(`${root}-other`), 'main')
    const idle = await wt.create(r, 'agy', 'Idle one')
    const busy = await wt.create(r, 'codex', 'Busy one')
    await writeFile(join(busy.path, 'x.txt'), 'x\n')
    git(busy.path, 'add', '.')
    git(busy.path, 'commit', '-qm', 'x')

    expect((await wt.list(root)).map(w => w.branch).sort()).toEqual([busy.branch, idle.branch].sort())

    expect(await wt.remove(root, idle.path, 'main')).toEqual({ branchDeleted: true, branch: idle.branch })
    expect(await wt.remove(root, busy.path, 'main')).toEqual({ branchDeleted: false, branch: busy.branch })
    expect(git(root, 'branch', '--list', busy.branch)).toContain(busy.branch)
    expect(await wt.list(root)).toEqual([])
    await expect(wt.remove(root, join(`${root}-other`), 'main')).rejects.toThrow('not a Grip worktree')
  })
})

describe('helpers', () => {
  it('parses porcelain output', () => {
    const list =
      'worktree /r/app\nHEAD abc123\nbranch refs/heads/main\n\nworktree /r/app-worktrees/codex-x\nHEAD def456\nbranch refs/heads/grip/codex-x\n'
    expect(parseWorktreeList(list)).toEqual([
      { path: '/r/app', folder: 'app', branch: 'main', head: 'abc123', main: true },
      { path: '/r/app-worktrees/codex-x', folder: 'codex-x', branch: 'grip/codex-x', head: 'def456', main: false },
    ])
    expect(parseStatusFiles(' M src/a.ts\nR  old.ts -> new.ts\n?? "with space.txt"')).toEqual(['src/a.ts', 'new.ts', 'with space.txt'])
  })

  it('slugifies titles', () => {
    expect(slugify('  Fix: the Login bug (#23)  ')).toBe('fix-the-login-bug-23')
    expect(slugify('!!!')).toBe('run')
    expect(slugify('a'.repeat(80)).length).toBe(40)
  })

  it('finds overlapping files and measures disk use', async () => {
    expect(overlappingFiles(['a', 'b', 'c'], ['c', 'a'])).toEqual(['a', 'c'])
    const root = await repo()
    const usage = await diskUsage(join(root, 'src'))
    expect(usage).toEqual({ bytes: 'export const a = 1\n'.length, complete: true })
  })
})
