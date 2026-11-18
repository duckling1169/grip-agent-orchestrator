import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { Worktrees } from '../git/worktrees.js'
import { RunManager } from '../runs/manager.js'
import { RunStore } from '../runs/store.js'
import { FakeClaw } from '../testing/fake-claw.js'
import { ChatManager } from './manager.js'
import { ChatStore } from './store.js'
import { chatOfToken } from './token.js'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function setup(options: { clawReady?: () => Promise<void>; killWorkers?: () => Promise<void> } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'grip-chat-')))
  dirs.push(dir)
  const chats = await ChatStore.open(join(dir, 'home'))
  const runStore = await RunStore.open(join(dir, 'home'))
  const claw = new FakeClaw()
  const runs = new RunManager({ store: runStore, worktrees: new Worktrees(), claw })
  const manager = new ChatManager({ chats, runStore, runs, claw, secret: 'secret', mcpUrl: () => 'http://127.0.0.1:123/mcp', ...options })
  return { dir, chats, runStore, claw, runs, manager }
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for state')
}

it('starts Claude with a chat token and queues messages for the resumed turn', async () => {
  const t = await setup()
  const chat = await t.manager.startChat({ folder: t.dir, engine: 'claude', model: 'opus', message: '\n  Hello there\nMore' })
  expect(chat.title).toBe('Hello there')
  await t.claw.waitForSend(chat.session!)
  const start = t.claw.starts[0]!
  expect(start).toMatchObject({
    name: chat.session,
    cwd: t.dir,
    engine: 'claude',
    model: 'opus',
    allowedTools: ['mcp__grip'],
    // Claude's own subagents would die when the turn ends, out of the app's sight.
    disallowedTools: ['Agent', 'Task'],
    permissionMode: 'auto',
  })
  expect(start.appendSystemPrompt).toContain('delegate')
  expect(start.mcpConfig).toBe(join(t.chats.chatDir(chat.id), 'mcp.json'))
  const config = JSON.parse(await readFile(join(t.chats.chatDir(chat.id), 'mcp.json'), 'utf8'))
  expect(config.mcpServers.grip.url).toBe('http://127.0.0.1:123/mcp')
  expect(chatOfToken('secret', config.mcpServers.grip.headers.Authorization.slice('Bearer '.length))).toBe(chat.id)
  await t.manager.message(chat.id, 'one')
  await t.manager.message(chat.id, 'two')
  t.claw.answer(chat.session!, { output: 'First reply', sessionId: 'conv' })
  await until(() => t.claw.sends.length === 2)
  expect(t.claw.sends[1]?.message).toBe('one\n\ntwo')
  expect(t.claw.starts[1]?.resumeSessionId).toBe('conv')
  t.claw.answer(chat.session!, { output: 'Second reply' })
  await until(() => t.chats.get(chat.id)?.status === 'idle')
})

it('starts a chat without a message and titles it from the first one', async () => {
  const t = await setup()
  const chat = await t.manager.startChat({ folder: t.dir, engine: 'claude' })
  expect(chat).toMatchObject({ status: 'idle', turns: 0, title: `New chat in ${basename(t.dir)}` })
  expect(t.claw.starts).toHaveLength(0)
  await t.manager.message(chat.id, 'Fix the login page\nDetails')
  expect(t.chats.get(chat.id)?.title).toBe('Fix the login page')
  await t.claw.waitForSend(chat.session!)
  t.claw.answer(chat.session!, { output: 'On it' })
  await until(() => t.chats.get(chat.id)?.status === 'idle')
  await t.manager.message(chat.id, 'Second')
  expect(t.chats.get(chat.id)?.title).toBe('Fix the login page')
})

it('uses a changed model and effort from the next turn, and keeps them after a restart', async () => {
  const t = await setup()
  const chat = await t.manager.startChat({ folder: t.dir, engine: 'claude', model: 'claude-opus-5-5', message: 'Hello' })
  await t.claw.waitForSend(chat.session!)
  await t.chats.configure(chat.id, { model: 'claude-sonnet-5-5', effort: 'low' })
  t.claw.answer(chat.session!, { output: 'Hi', sessionId: 'conv' })
  await until(() => t.chats.get(chat.id)?.status === 'idle')
  await t.manager.message(chat.id, 'Next')
  await until(() => t.claw.starts.length === 2)
  expect(t.claw.starts[0]).toMatchObject({ model: 'claude-opus-5-5' })
  expect(t.claw.starts[1]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low', resumeSessionId: 'conv' })
  t.claw.answer(chat.session!, { output: 'Done' })
  await until(() => t.chats.get(chat.id)?.status === 'idle')
  await t.chats.configure(chat.id, { model: null, effort: null })
  const reopened = await ChatStore.open(join(t.dir, 'home'))
  expect(reopened.get(chat.id)).toMatchObject({ model: null, effort: null })
})

it('deletes a working chat: stops its turn, and stays deleted after a restart', async () => {
  const t = await setup()
  const chat = await t.manager.startChat({ folder: t.dir, engine: 'claude', message: 'Hello' })
  await t.claw.waitForSend(chat.session!)
  await t.manager.delete(chat.id)
  expect((await t.claw.listSessions()).map(session => session.name)).not.toContain(chat.session)
  expect(t.chats.get(chat.id)).toBeNull()
  expect(t.chats.list()).toEqual([])
  const reopened = await ChatStore.open(join(t.dir, 'home'))
  expect(reopened.get(chat.id)).toBeNull()
  expect(reopened.isDeleted(chat.id)).toBe(true)
})

it('notes an unread worker once to an idle chat', async () => {
  const t = await setup()
  const chat = await t.manager.startChat({ folder: t.dir, engine: 'claude', message: 'Hello' })
  await t.claw.waitForSend(chat.session!)
  t.claw.answer(chat.session!, { output: 'Ready' })
  await until(() => t.chats.get(chat.id)?.status === 'idle')
  const run = await t.runs.delegate({ folder: t.dir, engine: 'codex', brief: { text: 'Fix it' }, chatId: chat.id })
  await t.claw.waitForSend(run.session)
  t.claw.answer(run.session, { output: 'Fixed' })
  await until(() => t.claw.sends.length === 3)
  expect(t.claw.sends[2]?.message).toBe(
    `[grip] These workers finished and you have not read them yet:\n- Fix it (codex, run ${run.id}, done)\nRead each with wait_any or result.`,
  )
  t.claw.answer(chat.session!, { output: 'OK' })
  await until(() => t.chats.get(chat.id)?.status === 'idle')
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(t.claw.sends).toHaveLength(3)
})

it('stops the chat and its running workers', async () => {
  const t = await setup()
  const chat = await t.manager.startChat({ folder: t.dir, engine: 'claude', message: 'Hello' })
  const run = await t.runs.delegate({ folder: t.dir, engine: 'codex', brief: { text: 'Fix' }, chatId: chat.id })
  await t.claw.waitForSend(chat.session!)
  await t.claw.waitForSend(run.session)
  await t.manager.stop(chat.id)
  expect(t.chats.get(chat.id)?.status).toBe('stopped')
  expect(t.runStore.get(run.id)?.status).toBe('stopped')
})

it('refuses non-Claude hosts and names external chats', async () => {
  const t = await setup()
  await expect(t.manager.startChat({ folder: t.dir, engine: 'codex', message: 'Hello' })).rejects.toThrow(
    'Only Claude can host a chat today',
  )
  const chat = await t.manager.externalChat({ host: 'claude-code', folder: t.dir })
  expect(chat).toMatchObject({ kind: 'external', title: `Claude Code chat in ${basename(t.dir)}` })
  await expect(t.manager.message(chat.id, 'Hi')).rejects.toThrow('This chat runs in its own host; reply to it there.')
})

it('does not start a session after stopping while Claw becomes ready', async () => {
  let ready!: () => void
  const t = await setup({
    clawReady: () =>
      new Promise<void>(resolve => {
        ready = resolve
      }),
  })
  const chat = await t.manager.startChat({ folder: t.dir, engine: 'claude', message: 'Hello' })
  await t.manager.stop(chat.id)
  ready()
  await until(() => t.chats.get(chat.id)?.status === 'stopped')
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(t.claw.starts).toHaveLength(0)
})

it('preserves a stopped turn when the chat is resumed', async () => {
  const t = await setup()
  const chat = await t.manager.startChat({ folder: t.dir, engine: 'claude', message: 'First' })
  await t.claw.waitForSend(chat.session!)
  await t.manager.stop(chat.id)
  await until(() => !t.claw.sessions.has(chat.session!))
  await until(() => t.chats.get(chat.id)?.status === 'stopped')
  // The old turn's cleanup runs asynchronously after stop.
  await new Promise(resolve => setTimeout(resolve, 20))
  await t.manager.message(chat.id, 'Second')
  await t.claw.waitForSend(chat.session!)
  expect((await t.chats.turn(chat.id, 1)).message).toBe('First')
  expect((await t.chats.turn(chat.id, 2)).message).toBe('Second')
  t.claw.answer(chat.session!, { output: 'Done' })
  await until(() => t.chats.get(chat.id)?.status === 'idle')
})

it('bounds stop-all and suppresses notes to idle chats', async () => {
  let kills = 0
  const t = await setup({
    killWorkers: async () => {
      kills++
    },
  })
  const idle = await t.manager.startChat({ folder: t.dir, engine: 'claude', message: 'Idle' })
  await t.claw.waitForSend(idle.session!)
  t.claw.answer(idle.session!, { output: 'Ready' })
  await until(() => t.chats.get(idle.id)?.status === 'idle')
  const active = await t.manager.startChat({ folder: t.dir, engine: 'claude', message: 'Active' })
  await t.claw.waitForSend(active.session!)
  t.claw.hangStops = true
  await t.manager.stopAll({ graceMs: 10 })
  expect(kills).toBe(1)
  expect(t.chats.get(idle.id)?.status).toBe('stopped')
  expect(t.chats.get(active.id)?.status).toBe('stopped')
})
