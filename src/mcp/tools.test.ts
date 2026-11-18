import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, expect, it, vi } from 'vitest'

import { ChatManager } from '../chats/manager.js'
import { ChatStore } from '../chats/store.js'
import { Worktrees } from '../git/worktrees.js'
import { Quota } from '../quota/quota.js'
import { RunManager } from '../runs/manager.js'
import { RunStore } from '../runs/store.js'
import { FakeClaw } from '../testing/fake-claw.js'
import { createGripMcpServer } from './tools.js'
import type { McpCaller } from './tools.js'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup() {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'grip-mcp-tools-')))
  cleanups.push(() => rm(folder, { recursive: true, force: true }))
  const home = join(folder, 'home')
  const claw = new FakeClaw()
  const runStore = await RunStore.open(home)
  const runs = new RunManager({ store: runStore, worktrees: new Worktrees(), claw })
  cleanups.push(() => runs.stopAll())
  const chats = new ChatManager({
    chats: await ChatStore.open(home),
    runStore,
    runs,
    claw,
    secret: 'test',
    mcpUrl: () => 'http://127.0.0.1:18797/mcp',
  })
  const quota = await Quota.open({
    path: join(home, 'quota.json'),
    readers: { claude: async () => null, codex: async () => null, agy: async () => null },
  })

  async function connect(caller: McpCaller) {
    const server = createGripMcpServer(runs, quota, undefined, caller)
    const client = new Client({ name: 'test-orchestrator', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    cleanups.push(() => client.close())
    return client
  }

  return { folder, runs, chats, connect }
}

const json = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0]!.text)

it('creates one chat for parallel first delegations and reuses it for a later title', async () => {
  const { folder, chats, connect } = await setup()
  const caller: McpCaller = { chats, host: 'test-orchestrator' }
  const client = await connect(caller)
  const create = vi.spyOn(chats, 'externalChat')
  expect(client.getInstructions()).toContain('chat_title')
  expect(json(await client.callTool({ name: 'wait_any', arguments: { timeout_sec: 0 } }))).toBeNull()
  expect(create).not.toHaveBeenCalled()

  const delegate = (brief_text: string, chat_title?: string) =>
    client.callTool({ name: 'delegate', arguments: { folder, engine: 'codex', brief_text, chat_title } }).then(json)
  const [first, second] = await Promise.all([delegate('First brief', 'Initial title'), delegate('Second brief')])
  expect(create).toHaveBeenCalledTimes(1)
  expect(chats.list()).toMatchObject([{ id: first.chatId, title: 'Initial title', host: 'test-orchestrator', folder }])
  expect(second.chatId).toBe(first.chatId)

  expect((await delegate('Third brief', 'Updated title')).chatId).toBe(first.chatId)
  expect(chats.get(first.chatId)?.title).toBe('Updated title')
})

it('keeps a chat waiting until all MCP sessions stop waiting', async () => {
  const { folder, runs, chats, connect } = await setup()
  const chat = await chats.externalChat({ folder })
  const first = await connect({ chats, chatId: chat.id })
  const second = await connect({ chats, chatId: chat.id })
  const waitAny = vi.spyOn(runs, 'waitAny')
  const waiting = vi.spyOn(chats, 'setWaiting')

  const cancelFirst = new AbortController()
  const firstWait = expect(first.callTool({ name: 'wait_any', arguments: {} }, undefined, { signal: cancelFirst.signal })).rejects.toThrow()
  await vi.waitFor(() => expect(waitAny).toHaveBeenCalledTimes(1))
  const secondWait = expect(second.callTool({ name: 'wait_any', arguments: { run_ids: [] } })).rejects.toThrow()
  await vi.waitFor(() => expect(waitAny).toHaveBeenCalledTimes(2))
  expect(waitAny.mock.calls[0]?.[0]).toMatchObject({ chatId: chat.id })
  expect(waitAny.mock.calls[1]?.[0]).toMatchObject({ ids: [] })
  expect(waiting.mock.calls).toEqual([[chat.id, true]])

  cancelFirst.abort()
  await firstWait
  await expect(waitAny.mock.results[0]?.value).resolves.toBeNull()
  expect(chats.get(chat.id)?.waiting).toBe(true)

  await second.close()
  await secondWait
  await expect(waitAny.mock.results[1]?.value).resolves.toBeNull()
  expect(chats.get(chat.id)?.waiting).toBe(false)
  expect(waiting.mock.calls).toEqual([
    [chat.id, true],
    [chat.id, false],
  ])
})
