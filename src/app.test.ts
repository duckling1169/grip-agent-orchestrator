import { readFile } from 'node:fs/promises'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

import type { MoxyOptions } from './app.js'
import { DatabaseInUseError } from './db/database.js'
import { Database } from './db/database.js'
import { MOXY_SCHEMA } from './db/schema.js'
import { loadOrCreateToken } from './files.js'
import { ConversationStore, userMessage } from './moxy/store.js'
import { moxyPaths } from './paths.js'
import type { LeaderReply } from './runtime/leaders/leader.js'
import { ClawClient } from './runtime/claw/client.js'
import { ClawProcess } from './runtime/claw/process.js'
import { freePort } from './ports.js'
import { FAKE_CLAW_CLI, temporaryHome } from './testing/harness.js'
import { echoLeader, startTestMoxy } from './testing/test-moxy.js'
import { MoxyClient } from './web/client.js'

const leader = echoLeader()
const start = (options: MoxyOptions = {}) => startTestMoxy({ leaders: () => leader, ...options })

describe('startMoxy', () => {
  it('starts Claw with a token kept in the data home', async () => {
    const moxy = await start()
    const token = await readFile(moxy.paths.clawToken, 'utf8')
    expect(moxy.clawVersion).toBe('7.23.4')
    expect(await new ClawClient(`http://127.0.0.1:${moxy.clawPort}`, token).health()).toMatchObject({ version: '7.23.4' })
  })

  it('stops Claw and releases the data home', async () => {
    const moxy = await start()
    const client = new ClawClient(`http://127.0.0.1:${moxy.clawPort}`, '')
    await moxy.stop()
    expect(await client.health(500)).toBeNull()

    await start({ home: moxy.paths.home })
  })

  it('reconciles a surviving Claw before starting a replacement on its port', async () => {
    const paths = moxyPaths(await temporaryHome())
    const port = await freePort()
    const token = await loadOrCreateToken(paths.clawToken)
    const client = new ClawClient(`http://127.0.0.1:${port}`, token)
    const orphan = new ClawProcess({ client, port, cliPath: FAKE_CLAW_CLI, logFile: paths.clawLog, restartDelaysMs: [60_000] })
    await orphan.start()
    onTestFinished(() => orphan.stop())
    const database = Database.open(paths.database, MOXY_SCHEMA)
    const conversation = new ConversationStore(database)
    conversation.receive(userMessage('Finish this', 'crash'))
    conversation.beginTurn()
    database.close()
    const oldPid = orphan.pid
    const owned = vi.spyOn(ClawClient.prototype, 'verifyRecoveryToken').mockResolvedValue(true)
    try {
      const moxy = await start({ home: paths.home, clawPort: port })
      expect(owned).toHaveBeenCalledOnce()
      expect(oldPid).not.toBeNull()
      await expect.poll(() => orphan.running).toBe(false)
      await moxy.loop.idle()
      const turns = moxy.conversation.conversation().flatMap(entry => (entry.type === 'moxy' ? [entry.turn.status] : []))
      expect(turns).toEqual(['interrupted', 'finished'])
      await moxy.stop()
      expect(await client.health(500)).toBeNull()
    } finally {
      owned.mockRestore()
    }
  })

  it('stops despite a leader that never finishes its run or stop', async () => {
    const running = Promise.withResolvers<void>()
    const leader = {
      run: () => {
        running.resolve()
        return new Promise<LeaderReply>(() => {})
      },
      stop: () => new Promise<void>(() => {}),
    }
    const moxy = await startTestMoxy({ leaders: () => leader })
    moxy.conversation.receive(userMessage('Do this', 'hung-leader'))
    moxy.loop.wake()
    await running.promise
    await moxy.stop()
    expect(await new ClawClient(`http://127.0.0.1:${moxy.clawPort}`, '').health(500)).toBeNull()
    await start({ home: moxy.paths.home })
  }, 12_000)

  it('keeps the machine awake only while a turn runs', async () => {
    const held: boolean[] = []
    let finish = () => {}
    const slowLeader = {
      run: () => new Promise<LeaderReply>(resolve => (finish = () => resolve({ output: 'Done.', error: null, nativeSessionId: null }))),
      stop: async () => {},
    }
    const moxy = await startTestMoxy({ leaders: () => slowLeader, keepAwake: { set: active => held.push(active), release: () => {} } })
    moxy.conversation.receive(userMessage('Work on it', 'awake'))
    moxy.loop.wake()
    await expect.poll(() => held.at(-1)).toBe(true)
    finish()
    await expect.poll(() => held.at(-1)).toBe(false)
  })

  it('refuses a second Moxy on the same data home without starting Claw', async () => {
    const first = await start()
    const secondPort = await freePort()
    await expect(start({ home: first.paths.home, clawPort: secondPort })).rejects.toThrow(DatabaseInUseError)
    expect(await new ClawClient(`http://127.0.0.1:${secondPort}`, '').health(500)).toBeNull()
  })

  it('refuses an unsupported Claw and leaves it stopped', async () => {
    process.env.FAKE_CLAW_VERSION = '8.0.0'
    const clawPort = await freePort()
    try {
      await expect(start({ clawPort })).rejects.toThrow('Claw 8.0.0 is not supported')
    } finally {
      delete process.env.FAKE_CLAW_VERSION
    }
    expect(await new ClawClient(`http://127.0.0.1:${clawPort}`, '').health(500)).toBeNull()
  })

  it('answers a message through the local API and serves the leader its tools', async () => {
    const moxy = await start()
    const client = new MoxyClient(`http://127.0.0.1:${moxy.webPort}`, await readFile(moxy.paths.webToken, 'utf8'))
    const posted = await client.post('Hello', 'first')
    expect(posted).toEqual({ source: 'user:first', received: true })
    expect(await client.post('Hello', 'first')).toEqual({ source: 'user:first', received: false })
    expect(await client.reply(posted.source, 10)).toMatchObject({ status: 'finished', output: 'You said: Hello' })

    const request = leader.requests.at(-1)
    expect(request).toMatchObject({ cwd: moxy.paths.leaderWorkspace, mcp: { url: `http://127.0.0.1:${moxy.mcpPort}/mcp` } })
    const mcp = new Client({ name: 'test', version: '1' })
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(request!.mcp.url), {
        requestInit: { headers: { Authorization: `Bearer ${request!.mcp.token}` } },
      }),
    )
    expect((await mcp.listTools()).tools.map(tool => tool.name).sort()).toEqual([
      'delegate',
      'follow_up',
      'integrate',
      'memory_read',
      'memory_update',
      'message',
      'models',
      'quota',
      'ready',
      'reopen',
      'result',
      'stop',
      'task_create',
      'task_get',
      'task_update',
      'tasks',
      'workers',
    ])
    const created = await mcp.callTool({ name: 'task_create', arguments: { title: 'Notes' } })
    expect(await mcp.callTool({ name: 'models', arguments: { engine: 'codex' } })).toMatchObject({
      content: [{ text: expect.stringContaining('codex') as unknown }],
    })
    expect(await mcp.callTool({ name: 'quota', arguments: {} })).toMatchObject({
      content: [{ text: expect.stringContaining('checkedAt') as unknown }],
    })
    expect(
      await mcp.callTool({
        name: 'memory_update',
        arguments: { instructions: 'Keep changes focused', preferences: 'Use the repo preview' },
      }),
    ).not.toHaveProperty('isError')
    expect(await mcp.callTool({ name: 'memory_read', arguments: {} })).toMatchObject({
      content: [{ text: expect.stringContaining('Keep changes focused') as unknown }],
    })
    const scheduled = await mcp.callTool({
      name: 'follow_up',
      arguments: { action: 'schedule', due_at: '2099-01-01T00:00:00Z', prompt: 'Check the task again' },
    })
    const timer = JSON.parse((scheduled.content as { text: string }[])[0]?.text ?? '{}') as { id: string }
    expect(timer.id).toBeTruthy()
    expect(await mcp.callTool({ name: 'follow_up', arguments: { action: 'cancel', id: timer.id } })).toMatchObject({
      content: [{ text: expect.stringContaining('cancelled') as unknown }],
    })
    const task = JSON.parse((created.content as { text: string }[])[0]?.text ?? '{}') as { id: string }
    expect(
      await mcp.callTool({ name: 'delegate', arguments: { task_id: task.id, engine: 'claude', prompt: 'Add notes', model: 'opus' } }),
    ).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('choose an effort for Claude opus') as unknown }] })
    expect(await mcp.callTool({ name: 'ready', arguments: { task_id: task.id, how_to_try: 'Read them' } })).toMatchObject({
      content: [{ text: expect.stringContaining('"status": "done"') as unknown }],
    })
    expect(
      await mcp.callTool({
        name: 'delegate',
        arguments: { task_id: task.id, engine: 'claude', prompt: 'More notes', model: 'haiku' },
      }),
    ).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('is done; reopen it first') as unknown }] })
    expect(await mcp.callTool({ name: 'workers', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: '[]' }] })
    await mcp.close()
  })

  it('refuses the local API without its token', async () => {
    const moxy = await start()
    await expect(new MoxyClient(`http://127.0.0.1:${moxy.webPort}`, 'wrong').conversation()).rejects.toThrow('No Tailscale identity')
  })
})
