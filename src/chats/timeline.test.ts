import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { RunStore } from '../runs/store.js'
import { ChatStore } from './store.js'
import { buildTimeline } from './timeline.js'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

it('orders chat and worker events and excludes app-only views', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'grip-timeline-'))
  dirs.push(dir)
  let seconds = 0
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds++))
  const chats = await ChatStore.open(dir, now)
  const runs = await RunStore.open(dir, now)
  const chat = await chats.create({ kind: 'grip', title: 'Chat', engine: 'claude', folder: dir })
  const chatTurn = await chats.startTurn(chat.id, 'Hello', 'user')
  const run = await runs.create({
    title: 'Worker',
    engine: 'codex',
    folder: dir,
    cwd: dir,
    repo: null,
    brief: { kind: 'text', text: 'Do work' },
    chatId: chat.id,
  })
  const first = await runs.startTurn(run.id, 'Do work')
  await runs.endTurn(run.id, first, { output: 'A'.repeat(500) })
  await runs.markViewed(run.id, 'app')
  await runs.markViewed(run.id, 'orchestrator')
  const second = await runs.startTurn(run.id, 'One more', { fromUser: true })
  await runs.endTurn(run.id, second, { output: 'Failed', error: 'Oops' })
  await chats.endTurn(chat.id, chatTurn, { output: 'All done' })

  const timeline = await buildTimeline(chat, chats, runs)
  expect(timeline.map(entry => entry.kind)).toEqual(['message', 'handoff', 'worker-result', 'read', 'to-worker', 'worker-result', 'reply'])
  expect(timeline[0]).toMatchObject({ from: 'user', text: 'Hello' })
  expect(timeline[1]).toMatchObject({ runId: run.id, engine: 'codex', title: 'Worker' })
  expect(timeline[2]).toMatchObject({ runId: run.id, status: 'done', preview: 'A'.repeat(400) })
  expect(timeline[4]).toMatchObject({ runId: run.id, from: 'user', text: 'One more' })
  expect(timeline[5]).toMatchObject({ runId: run.id, status: 'failed', error: 'Oops' })
  expect(timeline[6]).toMatchObject({ text: 'All done', error: null })
  expect(timeline.map(entry => entry.at)).toEqual([...timeline.map(entry => entry.at)].sort())
})
