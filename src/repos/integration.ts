import { lastLine } from '../errors.js'
import { exec as defaultExec } from '../exec.js'
import type { Exec } from '../exec.js'
import { git, gitOk } from './git.js'
import { parseStatusFiles } from './git-parse.js'

export type IntegrationRequest = { repoRoot: string; base: string; branch: string; worktree: string; title: string }

export class Integrator {
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(private readonly run: Exec = defaultExec) {}

  integrate(request: IntegrationRequest): Promise<string> {
    const merged = (this.queues.get(request.repoRoot) ?? Promise.resolve()).then(() => this.merge(request))
    this.queues.set(
      request.repoRoot,
      merged.catch(() => undefined),
    )
    return merged
  }

  private async merge(request: IntegrationRequest): Promise<string> {
    const root = request.repoRoot
    await this.commitWorktree(request.worktree, request.title)
    const branch = await git(this.run, root, ['symbolic-ref', '-q', '--short', 'HEAD'])
    if (branch.code !== 0) throw new Error(`${root} is not on a branch; check out ${request.base} first`)
    if (branch.stdout !== request.base) throw new Error(`${root} is on ${branch.stdout}, not ${request.base}`)
    const dirty = parseStatusFiles(await gitOk(this.run, root, ['status', '--porcelain', '--untracked-files=no']))
    if (dirty.length) throw new Error(`${root} has uncommitted changes: ${dirty.join(', ')}`)
    if ((await git(this.run, root, ['merge-base', '--is-ancestor', request.branch, 'HEAD'])).code !== 0) {
      await this.mergeBranch(request)
    }
    return gitOk(this.run, root, ['rev-parse', 'HEAD'])
  }

  private async mergeBranch(request: IntegrationRequest): Promise<void> {
    const root = request.repoRoot
    const merged = await git(this.run, root, [
      'merge',
      '--no-ff',
      '--no-edit',
      '-m',
      `Merge ${request.branch}: ${request.title}`,
      request.branch,
    ])
    if (merged.code === 0) return
    const conflicts = (await gitOk(this.run, root, ['diff', '--name-only', '--diff-filter=U'])).split(/\r?\n/).filter(Boolean)
    await git(this.run, root, ['merge', '--abort'])
    throw new Error(
      conflicts.length
        ? `${request.branch} conflicts with ${request.base} in ${conflicts.join(', ')}`
        : `git merge ${request.branch} failed: ${lastLine(merged.stderr || merged.stdout)}`,
    )
  }

  private async commitWorktree(worktree: string, title: string): Promise<void> {
    if (!(await gitOk(this.run, worktree, ['status', '--porcelain', '--untracked-files=all']))) return
    await gitOk(this.run, worktree, ['add', '-A'])
    await gitOk(this.run, worktree, ['commit', '-q', '-m', title])
  }
}
