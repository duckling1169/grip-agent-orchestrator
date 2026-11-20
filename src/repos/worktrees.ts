import { realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { WorktreeDiff } from '../contracts/api.js'
import { exec as defaultExec } from '../exec.js'
import type { Exec } from '../exec.js'
import { git, gitOk } from './git.js'
import { basename, parseStatusFiles, slugify } from './git-parse.js'

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
      this.git(path, ['status', '--porcelain', '--untracked-files=all']),
      this.git(path, ['diff', '--name-only', baseCommit, 'HEAD']),
    ])
    const commitsAhead = Number(ahead) || 0
    const changedFiles = [...new Set([...committed.split(/\r?\n/).filter(Boolean), ...parseStatusFiles(status)])].sort()
    let lastCommit: WorktreeFacts['lastCommit'] = null
    if (commitsAhead > 0) {
      const [subject = '', at = ''] = (await this.git(path, ['log', '-1', '--format=%s%x00%cI'])).split('\u0000')
      lastCommit = { subject, at }
    }
    return { commitsAhead, changedFiles, lastCommit }
  }

  async diff(path: string, baseCommit: string): Promise<WorktreeDiff> {
    const [statText, trackedPatch, untracked] = await Promise.all([
      this.git(path, ['diff', '--stat', baseCommit]),
      this.git(path, ['diff', baseCommit]),
      this.git(path, ['ls-files', '--others', '--exclude-standard']),
    ])
    const untrackedFiles = untracked.split(/\r?\n/).filter(Boolean)
    const newFilePatches: string[] = []
    const skippedFiles: WorktreeDiff['skippedFiles'] = untrackedFiles
      .slice(MAX_NEW_FILES)
      .map(file => ({ file, reason: `more than ${MAX_NEW_FILES} new files` }))
    for (const file of untrackedFiles.slice(0, MAX_NEW_FILES)) {
      const size = await stat(join(path, file)).then(
        info => (info.isFile() ? info.size : null),
        () => null,
      )
      if (size === null) skippedFiles.push({ file, reason: 'not a readable file' })
      else if (size > MAX_NEW_FILE_BYTES) skippedFiles.push({ file, reason: `larger than ${MAX_NEW_FILE_BYTES / 1024} KiB` })
      else newFilePatches.push(await this.newFilePatch(path, file))
    }
    const patch = [trackedPatch, ...newFilePatches].filter(Boolean).join('\n')
    const truncated = patch.length > MAX_PATCH_CHARS
    return { stat: statText, patch: truncated ? patch.slice(0, MAX_PATCH_CHARS) : patch, truncated, untrackedFiles, skippedFiles }
  }

  private async newFilePatch(path: string, file: string): Promise<string> {
    const result = await this.run('git', ['-C', path, 'diff', '--no-index', '--', '/dev/null', file], { timeoutMs: 60_000 })
    const differs = result.code === 1
    if (!differs && result.code !== 0) throw new Error(`git diff --no-index ${file}: ${result.stderr.trim()}`)
    return result.stdout.replace(/\r?\n$/, '')
  }

  private git(cwd: string, args: string[]): Promise<string> {
    return gitOk(this.run, cwd, args)
  }
}
