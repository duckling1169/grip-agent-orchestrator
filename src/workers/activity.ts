// Claude events follow Claude Code's stream-json output: https://code.claude.com/docs/en/headless
// Codex events follow the Codex app-server protocol: https://github.com/openai/codex/tree/main/codex-rs/app-server

import { relative, isAbsolute } from 'node:path'

import type { WorkerStep } from '../contracts/api.js'
import type { ClawEvent } from '../runtime/claw/client.js'

const MAX_STEP_LENGTH = 140

type Json = Record<string, unknown>

export function latestStep(events: readonly ClawEvent[], cwd: string): WorkerStep | null {
  for (const event of [...events].reverse()) {
    const parsed = parse(event.content)
    const text = parsed && (claudeStep(parsed, cwd) ?? codexStep(parsed, cwd))
    if (text) return { text: clip(text), at: event.time }
  }
  return null
}

function claudeStep(event: Json, cwd: string): string | null {
  if (event.type === 'system' && event.subtype === 'task_started' && typeof event.description === 'string') return event.description
  if (event.type !== 'assistant') return null
  const content = (event.message as Json | undefined)?.content
  if (!Array.isArray(content)) return null
  const use = [...content].reverse().find((block: Json) => block?.type === 'tool_use') as Json | undefined
  if (!use) return null
  const input = (use.input ?? {}) as Json
  const file = typeof input.file_path === 'string' ? shown(input.file_path, cwd) : null
  switch (use.name) {
    case 'Bash':
    case 'PowerShell':
      return typeof input.description === 'string' ? input.description : `Running ${String(input.command ?? '')}`
    case 'Edit':
    case 'MultiEdit':
      return file && `Editing ${file}`
    case 'Write':
      return file && `Writing ${file}`
    case 'Read':
      return file && `Reading ${file}`
    case 'Grep':
    case 'Glob':
      return `Searching for ${String(input.pattern ?? '')}`
    case 'Agent':
    case 'Task':
      return typeof input.description === 'string' ? input.description : 'Running a subagent'
    default:
      return `Using ${String(use.name)}`
  }
}

function codexStep(event: Json, cwd: string): string | null {
  if (event.method !== 'item/started') return null
  const item = (event.params as Json | undefined)?.item as Json | undefined
  switch (item?.type) {
    case 'commandExecution': {
      const command = Array.isArray(item.command) ? item.command.join(' ') : String(item.command ?? '')
      return `Running ${command}`
    }
    case 'fileChange': {
      const paths = Array.isArray(item.changes) ? item.changes.map((change: Json) => shown(String(change.path), cwd)) : []
      return paths.length ? `Editing ${paths.join(', ')}` : 'Editing files'
    }
    case 'mcpToolCall':
      return `Using ${String(item.tool ?? 'a tool')}`
    case 'webSearch':
      return `Searching the web for ${String(item.query ?? '')}`
    default:
      return null
  }
}

function parse(content: string): Json | null {
  try {
    const value = JSON.parse(content) as unknown
    return value && typeof value === 'object' ? (value as Json) : null
  } catch {
    return null
  }
}

function shown(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path
  const inside = relative(cwd, path)
  return inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside.replaceAll('\\', '/') : path
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > MAX_STEP_LENGTH ? `${line.slice(0, MAX_STEP_LENGTH - 1)}…` : line
}
