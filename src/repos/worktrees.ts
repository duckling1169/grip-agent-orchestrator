import { lstat, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { FileChange, WorktreeDiff } from '../contracts/api.js'
import { exec as defaultExec } from '../exec.js'
import type { Exec } from '../exec.js'
import { git, gitOk } from './git.js'
import { basename, gitPaths, parseDiff, parseStatusFiles, slugify, UNKNOWN_COUNTS } from './git-parse.js'

export type Repo = { root: string; base: string }

export type PlannedWorktree = { repoRoot: string; path: string; branch: string; base: string; baseCommit: string }

export type WorktreeFacts = {
  commitsAhead: number
  changedFiles: string[]
  lastCommit: { subject: string; at: string } | null
}

export const BRANCH_PREFIX = 'moxy/'
const MAX_PATCH_CHARS = 200_000
const MAX_NEW_FILES = 50
const MAX_NEW_FILE_BYTES = 256 * 1024
const DIFF = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--numstat', '-z', '--patch']

export class Worktrees {
  constructor(private readonly run: Exec = defaultExec) {}

  async repoOf(folder: string): Promise<Repo | null> {
    const absolute = await realpath(resolve(folder))
    let commonDir: string
    try {
      commonDir = await this.git(absolute, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    } catch {
      return null
    }
    if (basename(commonDir) !== '.git') return null
    const root = await realpath(dirname(commonDir))
    const branch = await this.git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const base = branch === 'HEAD' ? await this.git(root, ['rev-parse', 'HEAD']) : branch
    return { root, base }
  }

  async plan(repo: Repo, name: { engine: string; title: string; id: string }): Promise<PlannedWorktree> {
    const folder = `${slugify(name.engine, 12)}-${slugify(name.title)}-${name.id}`
    return {
      repoRoot: repo.root,
      path: join(`${repo.root}-worktrees`, folder),
      branch: `${BRANCH_PREFIX}${folder}`,
      base: repo.base,
      baseCommit: await this.git(repo.root, ['rev-parse', repo.base]),
    }
  }

  async deliveryCommit(repoRoot: string, revision: string, base?: string): Promise<string> {
    const commit = await this.git(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]).catch(() => {
      throw new Error(`${revision} is not a commit in ${repoRoot}`)
    })
    const ref = base
      ? `refs/heads/${base}`
      : await this.git(repoRoot, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => {
          throw new Error(`check out the delivery branch in ${repoRoot} before calling ready`)
        })
    const branch = ref.slice('refs/heads/'.length)
    const tip = await this.git(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).catch(() => {
      throw new Error(`delivery branch ${branch} does not exist in ${repoRoot}`)
    })
    const ancestor = await git(this.run, repoRoot, ['merge-base', '--is-ancestor', commit, tip])
    if (ancestor.code === 1)
      throw new Error(`${revision} has not reached delivery branch ${branch} in ${repoRoot}; integrate it before calling ready`)
    if (ancestor.code !== 0) throw new Error(`could not verify delivery branch ${branch} in ${repoRoot}: ${ancestor.stderr.trim()}`)
    return commit
  }

  async add(planned: PlannedWorktree): Promise<void> {
    await this.git(planned.repoRoot, ['worktree', 'add', '-b', planned.branch, planned.path, planned.baseCommit])
  }

  async facts(path: string, baseCommit: string): Promise<WorktreeFacts> {
    const [ahead, status, committed] = await Promise.all([
      this.git(path, ['rev-list', '--count', `${baseCommit}..HEAD`]),
      this.git(path, ['status', '--porcelain', '-z', '--untracked-files=all']),
      this.git(path, ['diff', '--name-only', '-z', baseCommit, 'HEAD']),
    ])
    const commitsAhead = Number(ahead) || 0
    const changedFiles = [...new Set([...gitPaths(committed), ...parseStatusFiles(status)])].sort()
    let lastCommit: WorktreeFacts['lastCommit'] = null
    if (commitsAhead > 0) {
      const [subject = '', at = ''] = (await this.git(path, ['log', '-1', '--format=%s%x00%cI'])).split('\u0000')
      lastCommit = { subject, at }
    }
    return { commitsAhead, changedFiles, lastCommit }
  }

  async diff(path: string, baseCommit: string): Promise<WorktreeDiff> {
    const [tracked, untracked] = await Promise.all([
      this.git(path, [...DIFF, '--raw', '--find-renames', baseCommit, '--']),
      this.git(path, ['ls-files', '-z', '--others', '--exclude-standard']),
    ])
    const changes = parseDiff(tracked)
    const patches = [changes.patch]
    for (const [index, file] of gitPaths(untracked).entries()) {
      if (index >= MAX_NEW_FILES) {
        changes.files.push(skippedFile(file, `more than ${MAX_NEW_FILES} new files`))
        continue
      }
      const added = await this.newFileDiff(path, file)
      changes.files.push(added.file)
      patches.push(added.patch)
    }
    const patch = patches.filter(Boolean).join('\n')
    const truncated = patch.length > MAX_PATCH_CHARS
    return { files: changes.files, patch: patch.slice(0, MAX_PATCH_CHARS), truncated }
  }

  private async newFileDiff(path: string, file: string): Promise<{ file: FileChange; patch: string }> {
    const info = await lstat(join(path, file)).catch(() => null)
    if (!info || !(info.isFile() || info.isSymbolicLink())) return { file: skippedFile(file, 'not a readable file'), patch: '' }
    if (info.size > MAX_NEW_FILE_BYTES) return { file: skippedFile(file, `larger than ${MAX_NEW_FILE_BYTES / 1024} KiB`), patch: '' }
    const result = await git(this.run, path, [...DIFF, '--no-index', '--', '/dev/null', file])
    if (result.code !== 0 && result.code !== 1) throw new Error(`git diff --no-index ${file}: ${result.stderr.trim()}`)
    const { files, patch } = parseDiff(result.stdout)
    const summary = files[0] ?? skippedFile(file, 'no file summary returned by git')
    return { file: { ...summary, path: file }, patch }
  }

  private git(cwd: string, args: string[]): Promise<string> {
    return gitOk(this.run, cwd, args)
  }
}

function skippedFile(path: string, skipped: string): FileChange {
  return { path, status: 'added', ...UNKNOWN_COUNTS, skipped }
}
