import { expect, it } from 'vitest'

import { parseRoute, reconcile } from './state.js'
import type { AppState, ChatRecord, RunSummary } from './types.js'

const at = '2026-11-17T22:00:00.000Z'
const state: AppState = {
  you: 'tester',
  principal: { host: 'windows-pc', online: true },
  claw: { status: 'ready', version: '7.23.4' },
  keepAwake: { supported: true, holding: false },
  quota: { providers: [], verdict: { text: 'Waiting for a reading', tone: 'quiet' } },
  chats: [],
  runs: [],
}

function chat(id: string): ChatRecord {
  return {
    id,
    kind: 'grip',
    title: id,
    engine: 'claude',
    model: null,
    effort: null,
    folder: 'C:\\repo',
    host: null,
    status: 'working',
    error: null,
    turns: 1,
    waiting: false,
    createdAt: at,
    updatedAt: at,
  }
}

function run(id: string, chatId: string | null): RunSummary {
  return {
    id,
    chatId,
    title: id,
    engine: 'codex',
    model: null,
    effort: null,
    status: 'running',
    error: null,
    folder: 'C:\\repo',
    worktree: null,
    branch: null,
    turns: 1,
    unread: false,
    unseen: false,
    createdAt: at,
    finishedAt: null,
    retryOf: null,
  }
}

it('updates a worker in both lists and keeps independent workers outside chats', () => {
  const first = chat('c-first')
  const second = chat('c-second')
  const worker = run('r-worker', first.id)
  const independent = run('r-independent', null)
  let next = reconcile(state, { kind: 'run', value: worker })
  next = reconcile(next, { kind: 'chat', value: first })
  next = reconcile(next, { kind: 'chat', value: second })
  next = reconcile(next, { kind: 'run', value: independent })
  const done = { ...worker, status: 'done' as const, unseen: true, finishedAt: at }
  next = reconcile(next, { kind: 'run', value: done })
  next = reconcile(next, { kind: 'chat', value: { ...first, waiting: true } })

  expect(next?.runs).toEqual([independent, done])
  expect(next?.chats).toEqual([
    { ...second, runs: [] },
    { ...first, waiting: true, runs: [done] },
  ])
  expect(state.runs).toEqual([])
})

it('accepts fresh quota and Claw events and replaces prior state on reconnect', () => {
  const first = chat('c-first')
  const prior = reconcile(state, { kind: 'chat', value: first })
  const quota = { ...state.quota, verdict: { text: 'Codex is running low', tone: 'warn' as const } }
  const claw = { status: 'updating', version: '7.23.5' }
  const next = reconcile(reconcile(prior, { kind: 'quota', value: quota }), { kind: 'claw', value: claw })
  expect(next).toMatchObject({ quota, claw, chats: [{ id: first.id }] })
  const reconnect = { ...state, claw: { status: 'ready', version: '7.23.6' } }
  expect(reconcile(next, { kind: 'state', value: reconnect })).toEqual(reconnect)
})

it('accepts chat and worker routes and falls back to the list for malformed hashes', () => {
  expect(parseRoute('#/chats/c-first')).toEqual({ kind: 'chat', id: 'c-first' })
  expect(parseRoute('#/runs/r-worker/')).toEqual({ kind: 'run', id: 'r-worker' })
  expect(parseRoute('#/chats/%2f')).toEqual({ kind: 'home' })
  expect(parseRoute('#/')).toEqual({ kind: 'home' })
})
