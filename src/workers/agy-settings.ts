import { lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { Worker } from '../contracts/api.js'
import { isWithin, samePath } from '../repos/folders.js'
import { agyWorktreeBranch } from '../repos/worktrees.js'
import type { Worktrees } from '../repos/worktrees.js'

export async function agySettings(worker: Worker, worktrees: Worktrees, protectedFolders: readonly string[]): Promise<string> {
  const cwd = await permissionDirectory(worker.cwd, protectedFolders)
  const allow = [`write_file(${cwd})`]
  const deny: string[] = []
  const folder = basename(cwd)
  const branch = agyWorktreeBranch(folder)
  if (worker.repo?.branch === branch) {
    const layout = await worktrees.gitLayout(cwd)
    const common = join(worker.repo.root, '.git')
    const directory = join(common, 'worktrees', folder)
    const objects = join(common, 'objects')
    const ref = join('refs', 'heads', branch)
    if (
      !samePath(cwd, join(`${worker.repo.root}-worktrees`, folder)) ||
      !samePath(layout.common, common) ||
      !samePath(layout.directory, directory) ||
      !samePath(layout.objects, objects) ||
      layout.head !== `refs/heads/${branch}` ||
      layout.refFormat === 'reftable'
    )
      throw new Error(`refusing agy Git permissions for an unexpected worktree layout: ${cwd}`)

    await Promise.all([common, directory, objects].map(path => permissionDirectory(path, protectedFolders)))
    const branchFiles = [join(common, ref), join(common, 'logs', ref)]
    for (const file of branchFiles) {
      await createRefDirectory(dirname(file), common, protectedFolders)
      if ((await lstat(file).catch(missing))?.isSymbolicLink()) throw new Error(`refusing agy permissions for a Git symlink: ${file}`)
    }
    allow.push(`read_file(${common})`, ...[directory, objects, ...branchFiles.map(dirname)].map(path => `write_file(${path})`))
    deny.push(...['info', 'pack'].map(dir => `write_file(${join(objects, dir)})`))
  }
  return JSON.stringify({ enableTerminalSandbox: true, toolPermission: 'proceed-in-sandbox', permissions: { allow, deny } })
}

async function permissionDirectory(path: string, protectedFolders: readonly string[]): Promise<string> {
  const resolved = await realpath(path)
  if (!samePath(resolved, path) || !(await stat(resolved)).isDirectory() || /[\u0000-\u001f()*]/u.test(resolved)) {
    throw new Error(`refusing agy permissions for an invalid or redirected directory: ${path}`)
  }
  if (protectedFolders.some(folder => isWithin(resolved, folder) || isWithin(folder, resolved))) {
    throw new Error(`refusing agy permissions for a directory overlapping a protected folder: ${path}`)
  }
  return resolved
}

async function createRefDirectory(path: string, common: string, protectedFolders: readonly string[]): Promise<void> {
  if (!(await lstat(path).catch(missing))) {
    if (samePath(path, common)) throw new Error(`missing Git common directory: ${common}`)
    await createRefDirectory(dirname(path), common, protectedFolders)
    await mkdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  }
  await permissionDirectory(path, protectedFolders)
}

function missing(error: NodeJS.ErrnoException): undefined {
  if (error.code !== 'ENOENT') throw error
}
