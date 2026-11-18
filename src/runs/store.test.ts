import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { RunStore } from './store.js'
import type { NewRun } from './store.js'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function open(dir?: string) {
  const d = dir ?? (await mkdtemp(join(tmpdir(), 'grip-runs-')))
  if (!dir) dirs.push(d)
  return { dir: d, store: await RunStore.open(d) }
}

const input = (title = 'Fix login'): NewRun => ({
  title,
  engine: 'codex',
  folder: '/code/app',
  cwd: '/code/app-worktrees/codex-fix-login',
  repo: {
    root: '/code/app',
    base: 'main',
    baseCommit: 'abc',
    worktree: '/code/app-worktrees/codex-fix-login',
    branch: 'grip/codex-fix-login',
  },
  brief: { kind: 'path', path: 'docs/briefs/001-fix-login.md' },
  model: 'gpt-6.1',
})

describe('RunStore', () => {
  it('records a run through its turns and keeps the output', async () => {
    const { store } = await open()
    const run = await store.create(input())
    expect(run).toMatchObject({ status: 'running', turns: 0, session: `grip-${run.id}`, viewed: true })

    const turn = await store.startTurn(run.id, 'Do docs/briefs/001-fix-login.md')
    expect(turn).toBe(1)
    const done = await store.endTurn(run.id, turn, { output: 'DONE' })
    expect(done).toMatchObject({ status: 'done', turns: 1, viewed: false, error: null })
    expect(await store.turn(run.id, 1)).toEqual({ message: 'Do docs/briefs/001-fix-login.md', output: 'DONE' })

    const second = await store.startTurn(run.id, 'Also add a test')
    expect(second).toBe(2)
    expect(store.get(run.id)?.status).toBe('running')
    expect((await store.endTurn(run.id, 2, { output: 'nope', error: 'tests failed' })).status).toBe('failed')
  })

  it('rebuilds the same state from the log after a restart', async () => {
    const { dir, store } = await open()
    const a = await store.create(input('A'))
    await store.endTurn(a.id, await store.startTurn(a.id, 'go'), { output: 'ok' })
    await store.markViewed(a.id)
    const b = await store.create(input('B'))
    await store.startTurn(b.id, 'go')

    const reopened = (await open(dir)).store
    expect(reopened.get(a.id)).toEqual(store.get(a.id))
    expect(reopened.list().map(r => r.title)).toEqual(['B', 'A'])
    expect(reopened.running().map(r => r.id)).toEqual([b.id])
  })

  it('ignores a log line cut short by a crash', async () => {
    const { dir, store } = await open()
    const a = await store.create(input())
    await appendFile(join(dir, 'runs.jsonl'), '{"t":"turn-start')
    expect((await open(dir)).store.get(a.id)?.title).toBe('Fix login')
  })

  it('fails runs left running when Grip restarts', async () => {
    const { dir, store } = await open()
    const a = await store.create(input())
    await store.startTurn(a.id, 'go')
    const reopened = (await open(dir)).store
    const stuck = await reopened.interruptRunning('host slept/restarted')
    expect(stuck.map(r => r.id)).toEqual([a.id])
    expect(reopened.get(a.id)).toMatchObject({ status: 'failed', error: 'host slept/restarted', viewed: false })
    expect(await readFile(join(dir, 'runs.jsonl'), 'utf8')).toContain('"t":"interrupted"')
  })

  it('filters by status and folder', async () => {
    const { store } = await open()
    const a = await store.create(input('A'))
    await store.create({ ...input('B'), folder: '/code/other' })
    await store.markStopped(a.id)
    expect(store.list({ status: 'stopped' }).map(r => r.title)).toEqual(['A'])
    expect(store.list({ folder: '/code/other' }).map(r => r.title)).toEqual(['B'])
  })
})

describe('waitAny', () => {
  it('returns an already finished, unread run at once, oldest first', async () => {
    const { store } = await open()
    const a = await store.create(input('A'))
    const b = await store.create(input('B'))
    await store.endTurn(b.id, await store.startTurn(b.id, 'go'), { output: 'b' })
    await store.endTurn(a.id, await store.startTurn(a.id, 'go'), { output: 'a' })
    expect((await store.waitAny({ timeoutMs: 10 }))?.id).toBe(b.id)
    await store.markViewed(b.id)
    expect((await store.waitAny({ timeoutMs: 10 }))?.id).toBe(a.id)
  })

  it('waits for the next run to finish, and skips stopped ones', async () => {
    const { store } = await open()
    const a = await store.create(input('A'))
    const b = await store.create(input('B'))
    const waiting = store.waitAny({ timeoutMs: 2000 })
    await store.markStopped(a.id)
    await store.endTurn(b.id, await store.startTurn(b.id, 'go'), { output: '', error: 'crashed' })
    expect(await waiting).toMatchObject({ id: b.id, status: 'failed' })
  })

  it('only considers the runs asked about, and times out with null', async () => {
    const { store } = await open()
    const a = await store.create(input('A'))
    const b = await store.create(input('B'))
    await store.endTurn(a.id, await store.startTurn(a.id, 'go'), { output: 'a' })
    expect(await store.waitAny({ timeoutMs: 50, ids: [b.id] })).toBeNull()
  })

  it('stops waiting when aborted', async () => {
    const { store } = await open()
    const controller = new AbortController()
    const waiting = store.waitAny({ timeoutMs: 60_000, signal: controller.signal })
    controller.abort()
    expect(await waiting).toBeNull()
    expect(store.listenerCount('change')).toBe(0)
  })
})
