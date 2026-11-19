import { readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'

const MAX_DEPTH = 3
const MAX_REPOS = 100
const SKIPPED = new Set(['node_modules', 'dist', 'build'])

export async function knownRepos(folders: readonly string[], limit = MAX_REPOS): Promise<string[]> {
  const repos: string[] = []
  const visit = async (folder: string, depth: number): Promise<void> => {
    if (repos.length >= limit) return
    let entries: Dirent[]
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some(entry => entry.name === '.git')) {
      repos.push(folder)
      return
    }
    if (depth >= MAX_DEPTH) return
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.endsWith('-worktrees') || SKIPPED.has(entry.name)) continue
      await visit(join(folder, entry.name), depth + 1)
    }
  }
  for (const folder of folders) await visit(folder, 0)
  return repos.slice(0, limit)
}
