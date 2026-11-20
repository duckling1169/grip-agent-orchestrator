// parseStatusFiles and basename are adapted from duckling1169/agent-usage, hooks/lib/logic.ts.

import type { FileChange } from '../contracts/api.js'

export function gitPaths(output: string): string[] {
  return output.split('\0').filter(Boolean)
}

export function parseStatusFiles(porcelain: string): string[] {
  const entries = gitPaths(porcelain)
  const files: string[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    const status = entry.slice(0, 2)
    files.push(entry.slice(3))
    if (/[RC]/.test(status)) index++
  }
  return files
}

const FILE_STATUS: Record<string, FileChange['status']> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type-changed',
  U: 'unmerged',
}

export const UNKNOWN_COUNTS: Pick<FileChange, 'added' | 'removed' | 'binary'> = { added: null, removed: null, binary: null }

export function parseDiff(output: string): { files: FileChange[]; patch: string } {
  const boundary = output.indexOf('\0\0')
  const patch = boundary === -1 ? '' : output.slice(boundary + 2)
  const entries = (boundary === -1 ? output : output.slice(0, boundary)).split('\0')
  const statuses = new Map<string, FileChange['status']>()
  const files: FileChange[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    if (entry.startsWith(':')) {
      const code = entry.split(' ').at(-1)?.[0] ?? ''
      if (code === 'R' || code === 'C') index++
      statuses.set(entries[++index]!, FILE_STATUS[code] ?? 'unknown')
      continue
    }
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(entry)
    if (!match) continue
    const [, inserted, deleted, name] = match
    const path = name || entries[(index += 2)]!
    const binary = inserted === '-' || deleted === '-'
    files.push({
      path,
      status: statuses.get(path) ?? 'added',
      added: binary ? null : Number(inserted),
      removed: binary ? null : Number(deleted),
      binary,
      skipped: null,
    })
  }
  return { files, patch }
}

export function basename(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? path
  )
}

export function slugify(text: string, maxLength = 40): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '')
  return slug || 'work'
}
