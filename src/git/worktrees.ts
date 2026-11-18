import { readdir, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { exec as defaultExec, execOk } from '../exec.js'
import type { Exec } from '../exec.js'
import { basename, parseStatusFiles, parseWorktreeList, slugify } from './parse.js'

export type RepoInfo = {
  /** The main checkout, even when the folder given was inside one of its worktrees. */
  root: string
  /** The branch the main checkout is on, or its commit when detached. Worktrees start here. */
  base: string
}

export type CreatedWorktree = { path: string; branch: string; base: string; baseCommit: string }

export type GitFacts = {
  branch: string | null
  /** Commits on the worktree's branch since it left its base. */
  ahead: number
  /** Tracked files changed since the base, committed or not, plus untracked files. */
  changedFiles: string[]
  untrackedFiles: string[]
  lastCommit: { subject: string; at: string } | null
  newestEdit: { file: string; at: string } | null
}

export type WorktreeDiff = { baseCommit: string; stat: string; patch: string; untrackedFiles: string[] }

export type GripWorktree = { path: string; branch: string; ageMs: number | null }

/** Worktrees Grip creates live on branches under this prefix, so they are easy to tell apart. */
export const BRANCH_PREFIX = 'grip/'
const MAX_STATS = 60

/**
 * Git for worker runs: find a folder's repo, give a run its own worktree beside the repo (never
 * inside it), describe what changed there, and remove it when asked. Nothing is ever deleted
 * automatically, and a branch with unmerged commits is never deleted.
 */
export class Worktrees {
  constructor(private readonly run: Exec = defaultExec) {}

  private git(cwd: string, args: string[]): Promise<string> {
    return execOk(this.run, 'git', ['-C', cwd, ...args], 60_000).then(out => out.replace(/\r?\n$/, ''))
  }

  /** The repo a folder belongs to, or null when it is not in one. */
  async repoOf(folder: string): Promise<RepoInfo | null> {
    const abs = await realpath(resolve(folder))
    let common: string
    try {
      common = await this.git(abs, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    } catch {
      return null
    }
    // The common dir is the main checkout's .git; a bare repo has no checkout to branch from.
    if (basename(common) !== '.git') return null
    const root = await realpath(dirname(common))
    const branch = await this.git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const base = branch === 'HEAD' ? await this.git(root, ['rev-parse', 'HEAD']) : branch
    return { root, base }
  }

  /**
   * A new worktree for one run: `<repo>-worktrees/<engine>-<slug>` on branch
   * `grip/<engine>-<slug>`, cut from the repo's current base. A number is added when the name is
   * taken.
   */
  async create(repo: RepoInfo, engine: string, title: string): Promise<CreatedWorktree> {
    const parent = `${repo.root}-worktrees`
    const stem = `${slugify(engine, 12)}-${slugify(title)}`
    const taken = new Set(parseWorktreeList(await this.git(repo.root, ['worktree', 'list', '--porcelain'])).map(w => w.folder))
    const branches = new Set((await this.git(repo.root, ['branch', '--format=%(refname:short)'])).split(/\r?\n/))
    let name = stem
    for (let n = 2; taken.has(name) || branches.has(`${BRANCH_PREFIX}${name}`) || (await exists(join(parent, name))); n++) {
      name = `${stem}-${n}`
    }
    const path = join(parent, name)
    const branch = `${BRANCH_PREFIX}${name}`
    const baseCommit = await this.git(repo.root, ['rev-parse', repo.base])
    await this.git(repo.root, ['worktree', 'add', '-b', branch, path, baseCommit])
    return { path: await realpath(path), branch, base: repo.base, baseCommit }
  }

  /** What a run has done in its worktree so far, relative to the commit it started from. */
  async facts(path: string, baseCommit: string): Promise<GitFacts> {
    const [branch, ahead, status, committed] = await Promise.all([
      this.git(path, ['rev-parse', '--abbrev-ref', 'HEAD']),
      this.git(path, ['rev-list', '--count', `${baseCommit}..HEAD`]),
      this.git(path, ['status', '--porcelain', '--untracked-files=all']),
      this.git(path, ['diff', '--name-only', baseCommit, 'HEAD']),
    ])
    const commits = Number(ahead) || 0
    const pending = parseStatusFiles(status)
    const untrackedFiles = status
      .split(/\r?\n/)
      .filter(line => line.startsWith('?? '))
      .flatMap(line => parseStatusFiles(line))
    const changedFiles = [...new Set([...committed.split(/\r?\n/).filter(Boolean), ...pending])].sort()

    let lastCommit: GitFacts['lastCommit'] = null
    if (commits > 0) {
      const [subject = '', at = ''] = (await this.git(path, ['log', '-1', '--format=%s%x00%cI'])).split('\u0000')
      lastCommit = { subject, at }
    }

    let newestEdit: GitFacts['newestEdit'] = null
    for (const file of pending.slice(0, MAX_STATS)) {
      try {
        const s = await stat(join(path, file))
        if (s.isFile() && (!newestEdit || s.mtimeMs > Date.parse(newestEdit.at))) {
          newestEdit = { file, at: new Date(s.mtimeMs).toISOString() }
        }
      } catch {
        // Deleted files have no time.
      }
    }

    return { branch: branch === 'HEAD' ? null : branch, ahead: commits, changedFiles, untrackedFiles, lastCommit, newestEdit }
  }

  /** Everything the run changed against its starting commit, including uncommitted edits. */
  async diff(path: string, baseCommit: string): Promise<WorktreeDiff> {
    const [statText, patch, untracked] = await Promise.all([
      this.git(path, ['diff', '--stat', baseCommit]),
      this.git(path, ['diff', baseCommit]),
      this.git(path, ['ls-files', '--others', '--exclude-standard']),
    ])
    return { baseCommit, stat: statText, patch, untrackedFiles: untracked.split(/\r?\n/).filter(Boolean) }
  }

  /** The worktrees Grip made for a repo, newest last. */
  async list(repoRoot: string): Promise<GripWorktree[]> {
    const entries = parseWorktreeList(await this.git(repoRoot, ['worktree', 'list', '--porcelain']))
    const now = Date.now()
    const out: GripWorktree[] = []
    for (const e of entries) {
      if (e.main || !e.branch?.startsWith(BRANCH_PREFIX)) continue
      let ageMs: number | null = null
      try {
        ageMs = now - (await stat(e.path)).birthtimeMs
      } catch {
        // Folder gone; git still lists it until pruned.
      }
      out.push({ path: e.path, branch: e.branch, ageMs })
    }
    return out
  }

  /**
   * Remove a Grip worktree. Its branch goes too only when fully merged into the base; otherwise
   * the branch stays, so no commit is lost.
   */
  async remove(repoRoot: string, path: string, base: string): Promise<{ branchDeleted: boolean; branch: string }> {
    const entry = parseWorktreeList(await this.git(repoRoot, ['worktree', 'list', '--porcelain'])).find(
      e => samePath(e.path, path) && !e.main,
    )
    if (!entry?.branch?.startsWith(BRANCH_PREFIX)) throw new Error(`${path} is not a Grip worktree of ${repoRoot}`)
    await this.git(repoRoot, ['worktree', 'remove', '--force', entry.path])
    const merged = (await this.git(repoRoot, ['branch', '--merged', base, '--format=%(refname:short)'])).split(/\r?\n/)
    if (merged.includes(entry.branch)) {
      await this.git(repoRoot, ['branch', '-d', entry.branch])
      return { branchDeleted: true, branch: entry.branch }
    }
    return { branchDeleted: false, branch: entry.branch }
  }
}

/** Disk used by a folder, in bytes, stopping early past `limit` files so huge trees stay cheap. */
export async function diskUsage(path: string, limit = 200_000): Promise<{ bytes: number; complete: boolean }> {
  let bytes = 0
  let files = 0
  const stack = [path]
  while (stack.length) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        if (++files > limit) return { bytes, complete: false }
        try {
          bytes += (await stat(full)).size
        } catch {
          // Gone mid-walk.
        }
      }
    }
  }
  return { bytes, complete: true }
}

/** Two paths name the same folder, ignoring separators and, on Windows, case. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const s = resolve(p)
      .replace(/[\\/]+/g, '/')
      .replace(/\/$/, '')
    return process.platform === 'win32' ? s.toLowerCase() : s
  }
  return norm(a) === norm(b)
}

/** Files two runs have both changed: the overlap warning on a run's detail. */
export function overlappingFiles(a: readonly string[], b: readonly string[]): string[] {
  const other = new Set(b)
  return a.filter(f => other.has(f))
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
