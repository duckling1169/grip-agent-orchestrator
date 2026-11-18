import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { ChatStore } from './store.js'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

it('replays chat events and turn files, but not transient waiting state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'grip-chat-store-'))
  dirs.push(dir)
  const store = await ChatStore.open(dir)
  const chat = await store.create({ kind: 'grip', title: 'First', folder: dir, engine: 'claude' })
  await store.rename(chat.id, 'Renamed')
  const turn = await store.startTurn(chat.id, 'A note', 'grip')
  await store.endTurn(chat.id, turn, { output: 'Reply', sessionId: 'conversation' })
  store.setWaiting(chat.id, true)
  const fresh = await ChatStore.open(dir)
  expect(fresh.get(chat.id)).toMatchObject({
    title: 'Renamed',
    status: 'idle',
    turns: 1,
    fromGrip: [1],
    engineSessionId: 'conversation',
    waiting: false,
  })
  expect(await fresh.turn(chat.id, 1)).toEqual({ message: 'A note', output: 'Reply' })
  expect(fresh.history(chat.id).map(event => event.t)).toEqual(['created', 'named', 'turn-started', 'turn-ended'])
})

it('publishes transient reply snapshots, clears them on completion and rejects late chunks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'grip-chat-stream-'))
  dirs.push(dir)
  const store = await ChatStore.open(dir)
  const chat = await store.create({ kind: 'grip', title: 'Streaming', folder: dir, engine: 'codex' })
  const turn = await store.startTurn(chat.id, 'Hello', 'user')
  const snapshots: (string | undefined)[] = []
  store.on('change', chat => snapshots.push(chat.liveOutput))
  store.setLiveOutput(chat.id, turn, 'First chunk')
  expect(snapshots.at(-1)).toBe('First chunk')
  expect((await ChatStore.open(dir)).get(chat.id)?.liveOutput).toBeUndefined()
  await store.endTurn(chat.id, turn, { output: 'Complete reply' })
  expect(snapshots.at(-1)).toBeUndefined()
  expect(await store.turn(chat.id, turn)).toMatchObject({ output: 'Complete reply' })
  const next = await store.startTurn(chat.id, 'Next', 'user')
  store.setLiveOutput(chat.id, turn, 'Late previous chunk')
  expect(store.get(chat.id)?.liveOutput).toBeUndefined()
  store.setLiveOutput(chat.id, next, 'New reply')
  await store.markStopped(chat.id)
  store.setLiveOutput(chat.id, next, 'Late stopped chunk')
  expect(store.get(chat.id)?.liveOutput).toBeUndefined()
})
