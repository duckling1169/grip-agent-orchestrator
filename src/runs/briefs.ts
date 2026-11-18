import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import { basename } from '../git/parse.js'
import type { Brief } from './store.js'

export type ResolvedBrief = { brief: Brief; title: string; message: string }

const TITLE_MAX = 80

/**
 * Turn what the orchestrator gave as a brief into the run's title and first message. A path is
 * resolved against the folder and must be a file; the worker gets its absolute path, which works
 * even when the brief is uncommitted and so absent from the run's fresh worktree.
 */
export async function resolveBrief(input: { path?: string; text?: string }, folder: string): Promise<ResolvedBrief> {
  if (input.path && input.text) throw new Error('give a brief as a path or as text, not both')
  if (input.path) {
    const abs = await realpath(isAbsolute(input.path) ? input.path : resolve(folder, input.path)).catch(() => {
      throw new Error(`brief not found: ${input.path}`)
    })
    if (!(await stat(abs)).isFile()) throw new Error(`brief is not a file: ${input.path}`)
    const heading = firstHeading(await readFile(abs, 'utf8'))
    return {
      brief: { kind: 'path', path: abs },
      title: clip(heading ?? basename(abs).replace(/\.[^.]+$/, '')),
      message: `Do the work described in ${abs}.`,
    }
  }
  const text = input.text?.trim()
  if (!text) throw new Error('a brief is required')
  const firstLine = text.split(/\r?\n/).find(l => l.trim()) ?? text
  return { brief: { kind: 'text', text }, title: clip(firstLine.replace(/^#+\s*/, '')), message: text }
}

function firstHeading(markdown: string): string | null {
  const line = markdown.split(/\r?\n/).find(l => /^#{1,6}\s+\S/.test(l))
  return line ? line.replace(/^#+\s*/, '').trim() : null
}

function clip(text: string): string {
  const t = text.trim()
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t
}
