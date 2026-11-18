import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChatManager } from '../chats/manager.js'
import { ChatStore } from '../chats/store.js'
import { chatToken } from '../chats/token.js'
import { Worktrees } from '../git/worktrees.js'
import { Quota } from '../quota/quota.js'
import type { QuotaReaders } from '../quota/readers.js'
import { RunManager } from '../runs/manager.js'
import { RunStore } from '../runs/store.js'
import { FakeClaw } from '../testing/fake-claw.js'
import { startMcpHttp } from './http.js'
import type { McpHttpOptions } from './http.js'

const TOKEN = 'b'.repeat(64)
const AUTH = `Bearer ${TOKEN}`
const RPC_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'Mcp-Protocol-Version': LATEST_PROTOCOL_VERSION,
}
const LIST_REQUEST = JSON.stringify({ jsonrpc: '2.0', id: 'test-list', method: 'tools/list' })
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function setup({
  withChats = false,
  ...limits
}: Pick<McpHttpOptions, 'maxSessions' | 'sessionIdleMs'> & { withChats?: boolean } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'grip-mcp-')))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  const folder = join(base, 'notes')
  await mkdir(folder)
  const claw = new FakeClaw()
  const home = join(base, 'home')
  const runStore = await RunStore.open(home)
  const chatStore = await ChatStore.open(home)
  const manager = new RunManager({ store: runStore, worktrees: new Worktrees(), claw })
  const chats = new ChatManager({ chats: chatStore, runStore, runs: manager, claw, secret: TOKEN, mcpUrl: () => url.href })
  cleanups.push(async () => {
    const { stopped } = await manager.stopAll()
    await Promise.all(stopped.map(run => manager.settled(run.id)))
  })
  const window = (usedPercent: number) => ({
    name: '5h',
    usedPercent,
    resetsAt: '2099-01-01T00:00:00.000Z',
    stale: false,
    observedAt: null,
  })
  const readers: QuotaReaders = {
    codex: async () => ({ provider: 'codex', windows: [window(90)] }),
    agy: async () => ({ provider: 'agy', windows: [window(10)] }),
    claude: async () => {
      throw new Error('tests never call real models')
    },
  }
  const quota = await Quota.open({ path: join(home, 'quota.json'), readers })
  const models = {
    list: async () => [
      {
        engine: 'claude' as const,
        models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['high'], defaultEffort: null, isDefault: false }],
        error: null,
      },
      { engine: 'codex' as const, models: [], error: 'codex is not signed in' },
      {
        engine: 'agy' as const,
        models: [{ id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)', efforts: [], defaultEffort: null, isDefault: false }],
        error: null,
      },
    ],
  }
  const http = await startMcpHttp({ manager, quota, models, token: TOKEN, port: 0, chats: withChats ? chats : undefined, ...limits })
  cleanups.push(http.close)
  const url = new URL(`http://127.0.0.1:${http.port}/mcp`)

  async function connect(name = 'test-orchestrator', token = TOKEN) {
    const client = new Client({ name, version: '1' })
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
    cleanups.push(() => client.close())
    await client.connect(transport)
    return { client, transport }
  }

  async function finish(id: string, output: string) {
    await claw.waitForSend(`grip-${id}`)
    claw.answer(`grip-${id}`, { output })
    await manager.settled(id)
  }

  const { client, transport } = await connect()
  return { url, folder, claw, client, transport, connect, finish, http, chats, chatStore }
}

const json = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0]!.text)

async function listStatus(url: URL, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: 'POST', headers: { ...RPC_HEADERS, ...headers }, body: LIST_REQUEST })
  await res.body?.cancel()
  return res.status
}

async function delegate(client: Client, folder: string, brief: string, chatTitle?: string) {
  return json(await client.callTool({ name: 'delegate', arguments: { folder, engine: 'codex', brief_text: brief, chat_title: chatTitle } }))
}

async function poll(client: Client, runIds?: string[]) {
  return json(await client.callTool({ name: 'wait_any', arguments: { timeout_sec: 0, run_ids: runIds } }))
}

describe('Grip MCP over HTTP', () => {
  it('lists the orchestrator tools', async () => {
    const { client } = await setup()
    const names = (await client.listTools()).tools.map(t => t.name).sort()
    expect(names).toEqual(['delegate', 'list', 'message', 'models', 'quota', 'result', 'stop', 'wait_any'])
  })

  it('delegates, then hands the result back through wait_any', async () => {
    const { client, folder, claw } = await setup()
    const run = json(await client.callTool({ name: 'delegate', arguments: { folder, engine: 'agy', brief_text: 'Say hi' } }))
    expect(run).toMatchObject({ title: 'Say hi', engine: 'agy', status: 'running', unread: false })

    const waiting = client.callTool({ name: 'wait_any', arguments: { timeout_sec: 5 } })
    await claw.waitForSend(`grip-${run.id}`)
    claw.answer(`grip-${run.id}`, { output: 'hi' })
    const done = json(await waiting)
    expect(done).toMatchObject({ id: run.id, status: 'done', unread: false })
    expect(done.turns).toEqual([{ turn: 1, from: 'orchestrator', message: 'Say hi', output: 'hi' }])

    const listed = json(await client.callTool({ name: 'list', arguments: { status: 'done' } }))
    expect(listed.map((r: { id: string }) => r.id)).toEqual([run.id])
    expect(json(await client.callTool({ name: 'wait_any', arguments: { timeout_sec: 0 } }))).toBeNull()
  })

  it("lists each engine's models, or one engine's", async () => {
    const { client } = await setup()
    const all = json(await client.callTool({ name: 'models', arguments: {} }))
    expect(all.map((list: { engine: string }) => list.engine)).toEqual(['claude', 'codex', 'agy'])
    expect(all[1].error).toBe('codex is not signed in')
    expect(json(await client.callTool({ name: 'models', arguments: { engine: 'agy' } }))).toEqual([
      expect.objectContaining({ engine: 'agy', models: [expect.objectContaining({ id: 'gemini-4-argon-high' })] }),
    ])
  })

  it('reads quota, and notes a low provider when delegating to it', async () => {
    const { client, folder } = await setup()
    expect(json(await client.callTool({ name: 'quota', arguments: {} })).verdict.text).toBe('Waiting for a reading')
    const read = json(await client.callTool({ name: 'quota', arguments: { refresh: ['codex', 'agy'] } }))
    expect(read.verdict).toEqual({ text: 'Codex is running low (10% left)', tone: 'warn' })

    const codex = json(await client.callTool({ name: 'delegate', arguments: { folder, engine: 'codex', brief_text: 'A' } }))
    expect(codex.quotaNote).toBe('Codex is running low (10% left)')
    const agy = json(await client.callTool({ name: 'delegate', arguments: { folder, engine: 'agy', brief_text: 'B' } }))
    expect(agy.quotaNote).toBeUndefined()
  })

  it('reports tool errors as errors, not crashes', async () => {
    const { client } = await setup()
    const result = await client.callTool({ name: 'message', arguments: { run_id: 'r-nope', text: 'x' } })
    expect(result.isError).toBe(true)
    expect((result.content as { text: string }[])[0]!.text).toContain('unknown run r-nope')
  })

  it('authenticates every request and validates the Host and Origin', async () => {
    const { url, transport } = await setup()
    const session = { 'Mcp-Session-Id': transport.sessionId! }
    expect(await listStatus(url, session)).toBe(401)
    expect(await listStatus(url, { ...session, Authorization: 'Bearer wrong' })).toBe(401)
    expect(await listStatus(url, { ...session, Authorization: AUTH, Origin: 'https://evil.example' })).toBe(403)
    expect(await listStatus(url, { ...session, Authorization: AUTH, Origin: url.origin })).toBe(200)
    // fetch drops a custom Host header, so this one goes out through node:http.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        url,
        { method: 'POST', headers: { ...RPC_HEADERS, ...session, Authorization: AUTH, Host: 'evil.example' } },
        res => {
          res.resume()
          resolve(res.statusCode)
        },
      )
      req.on('error', reject)
      req.end(LIST_REQUEST)
    })
    expect(status).toBe(403)
  })

  it('requires initialization and binds sessions to their install or hosted chat credentials', async () => {
    const { url, folder, transport, connect, chats, chatStore } = await setup({ withChats: true })
    expect(await listStatus(url, { Authorization: AUTH })).toBe(400)
    expect(await listStatus(url, { Authorization: AUTH, 'Mcp-Session-Id': 'missing-session' })).toBe(404)

    const first = await chatStore.create({ kind: 'grip', folder, title: 'First hosted chat', engine: 'claude' })
    const second = await chatStore.create({ kind: 'grip', folder, title: 'Second hosted chat', engine: 'claude' })
    const external = await chats.externalChat({ folder })
    const firstToken = chatToken(TOKEN, first.id)
    const secondToken = chatToken(TOKEN, second.id)
    const firstHost = await connect('claude-code', firstToken)
    const secondHost = await connect('claude-code', secondToken)
    const wrongCredentials = [
      { id: transport.sessionId!, token: firstToken },
      { id: firstHost.transport.sessionId!, token: TOKEN },
      { id: firstHost.transport.sessionId!, token: secondToken },
      { id: secondHost.transport.sessionId!, token: firstToken },
    ]
    for (const { id, token } of wrongCredentials)
      expect(await listStatus(url, { 'Mcp-Session-Id': id, Authorization: `Bearer ${token}` })).toBe(403)
    for (const token of [
      'grip-chat.invalid',
      chatToken('wrong', first.id),
      chatToken(TOKEN, 'missing-chat'),
      chatToken(TOKEN, external.id),
    ])
      expect(await listStatus(url, { Authorization: `Bearer ${token}` })).toBe(401)

    expect(await delegate(firstHost.client, folder, 'Hosted worker', 'Updated hosted chat')).toMatchObject({ chatId: first.id })
    expect(chats.get(first.id)?.title).toBe('Updated hosted chat')
    expect(chats.list()).toHaveLength(3)
  })

  it('keeps external sessions in separate chats and lets explicit run IDs recover another chat’s results', async () => {
    const { client, folder, connect, chats, finish } = await setup({ withChats: true })
    const { client: other } = await connect('claude-code')
    expect(chats.list()).toEqual([])
    const first = await delegate(client, folder, 'First task', 'Project planning')
    await finish(first.id, 'First result')
    expect(chats.get(first.chatId)).toMatchObject({ kind: 'external', title: 'Project planning', host: 'test-orchestrator' })
    expect(await poll(other)).toBeNull()
    expect(chats.list()).toHaveLength(1)

    const second = await delegate(other, folder, 'Second task')
    expect(second.chatId).not.toBe(first.chatId)
    expect(chats.get(second.chatId)).toMatchObject({ title: 'Claude Code chat in notes', host: 'claude-code' })
    await finish(second.id, 'Second result')
    expect(await poll(other)).toMatchObject({ id: second.id })
    expect(await poll(other)).toBeNull()
    const listed = json(await other.callTool({ name: 'list', arguments: { status: 'done' } }))
    expect(listed).toContainEqual(expect.objectContaining({ id: first.id, unread: true }))
    expect(await poll(other, [first.id])).toMatchObject({ id: first.id, unread: false })
  })

  it('frees a session slot when a client terminates its session', async () => {
    const { connect, transport } = await setup({ maxSessions: 1 })
    await expect(connect()).rejects.toMatchObject({ code: 503 })
    await transport.terminateSession()
    await expect(connect()).resolves.toHaveProperty('transport.sessionId', expect.any(String))
  })

  it('keeps active waits past the idle limit and expires their sessions after cancellation', async () => {
    const idleMs = 200
    const { url, client, folder, chats, connect, transport } = await setup({ withChats: true, sessionIdleMs: idleMs })
    const run = await delegate(client, folder, 'Wait for cancellation')
    const cancel = new AbortController()
    const pending = expect(
      client.callTool({ name: 'wait_any', arguments: { timeout_sec: 30 } }, undefined, { signal: cancel.signal }),
    ).rejects.toThrow(/abort/i)
    await vi.waitFor(() => expect(chats.get(run.chatId)?.waiting).toBe(true))
    const idle = await connect('idle-orchestrator')
    await delay(idleMs * 3)
    expect(await listStatus(url, { Authorization: AUTH, 'Mcp-Session-Id': idle.transport.sessionId! })).toBe(404)
    expect(chats.get(run.chatId)?.waiting).toBe(true)

    cancel.abort()
    await pending
    await vi.waitFor(() => expect(chats.get(run.chatId)?.waiting).toBe(false))
    await delay(idleMs * 3)
    expect(await listStatus(url, { Authorization: AUTH, 'Mcp-Session-Id': transport.sessionId! })).toBe(404)
  })

  it('releases pending waits on session termination and server shutdown', async () => {
    const { url, http, folder, chats, chatStore, connect } = await setup({ withChats: true })
    const chat = await chatStore.create({ kind: 'grip', folder, title: 'Waiting chat', engine: 'claude' })
    const token = chatToken(TOKEN, chat.id)
    const first = await connect('claude-code', token)
    const id = first.transport.sessionId!
    const firstWait = expect(first.client.callTool({ name: 'wait_any', arguments: { timeout_sec: 30 } })).rejects.toThrow(/fetch failed/i)
    await vi.waitFor(() => expect(chats.get(chat.id)?.waiting).toBe(true))
    await first.transport.terminateSession()
    await firstWait
    await vi.waitFor(() => expect(chats.get(chat.id)?.waiting).toBe(false))
    expect(await listStatus(url, { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': id })).toBe(404)

    const second = await connect('claude-code', token)
    const secondWait = expect(second.client.callTool({ name: 'wait_any', arguments: { timeout_sec: 30 } })).rejects.toThrow(/fetch failed/i)
    await vi.waitFor(() => expect(chats.get(chat.id)?.waiting).toBe(true))
    await http.close()
    await secondWait
    expect(chats.get(chat.id)?.waiting).toBe(false)
  })
})
