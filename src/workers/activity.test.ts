import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ClawEvent } from '../runtime/claw/client.js'
import { latestStep } from './activity.js'

const CWD = join('/work', 'repo')

function events(...contents: unknown[]): ClawEvent[] {
  return contents.map((content, index) => ({
    time: `2026-11-19T10:0${index}:00.000Z`,
    type: 'output',
    content: typeof content === 'string' ? content : JSON.stringify(content),
  }))
}

function toolUse(name: string, input: Record<string, unknown>) {
  return {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Next' },
        { type: 'tool_use', name, input },
      ],
    },
  }
}

function codexItem(item: Record<string, unknown>) {
  return { method: 'item/started', params: { item } }
}

describe('latestStep', () => {
  it('describes the newest Claude tool call, with paths relative to the worktree', () => {
    expect(
      latestStep(events(toolUse('Read', { file_path: join(CWD, 'a.ts') }), toolUse('Edit', { file_path: join(CWD, 'src', 'b.ts') })), CWD),
    ).toEqual({ text: 'Editing src/b.ts', at: '2026-11-19T10:01:00.000Z' })
    expect(latestStep(events(toolUse('Bash', { command: 'npm test', description: 'Run the tests' })), CWD)?.text).toBe('Run the tests')
    expect(latestStep(events(toolUse('Bash', { command: 'npm test' })), CWD)?.text).toBe('Running npm test')
    expect(latestStep(events(toolUse('Grep', { pattern: 'TODO' })), CWD)?.text).toBe('Searching for TODO')
    expect(latestStep(events(toolUse('WebFetch', { url: 'https://example.com' })), CWD)?.text).toBe('Using WebFetch')
    expect(latestStep(events({ type: 'system', subtype: 'task_started', description: 'Review the diff' }), CWD)?.text).toBe(
      'Review the diff',
    )
  })

  it('describes the newest Codex item', () => {
    expect(latestStep(events(codexItem({ type: 'commandExecution', command: 'cargo test' })), CWD)?.text).toBe('Running cargo test')
    expect(
      latestStep(events(codexItem({ type: 'fileChange', changes: [{ path: join(CWD, 'lib.rs') }, { path: 'main.rs' }] })), CWD)?.text,
    ).toBe('Editing lib.rs, main.rs')
    expect(latestStep(events(codexItem({ type: 'mcpToolCall', tool: 'search' })), CWD)?.text).toBe('Using search')
  })

  it('skips events that say nothing about the work and clips long steps', () => {
    const noise = events(toolUse('Bash', { command: 'x'.repeat(400) }), { type: 'tool_progress' }, 'not json', { method: 'item/completed' })
    const step = latestStep(noise, CWD)
    expect(step?.at).toBe('2026-11-19T10:00:00.000Z')
    expect(step?.text).toHaveLength(140)
    expect(step?.text.endsWith('…')).toBe(true)
    expect(latestStep(events({ type: 'result', result: 'Done' }), CWD)).toBeNull()
  })
})
