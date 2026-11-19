import { readFile } from 'node:fs/promises'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'

import { startMoxy } from './app.js'
import type { Moxy, MoxyOptions } from './app.js'
import { DatabaseInUseError } from './db/database.js'
import { ClawClient } from './runtime/claw/client.js'
import type { LeaderRunner, LeaderTurnRequest } from './runtime/leaders/leader.js'
import { FAKE_CLAW_CLI, freePort, silentLog, temporaryHome } from './testing/harness.js'
import { MoxyClient } from './web/client.js'

const running: Moxy[] = []

const echoLeader: LeaderRunner & { requests: LeaderTurnRequest[] } = {
  requests: [],
  async run(request) {
    this.requests.push(request)
    return { output: `You said: ${request.message}`, error: null, nativeSessionId: 'native-1' }
  },
  async stop() {},
}

afterEach(async () => {
  await Promise.all(running.splice(0).map(moxy => moxy.stop()))
})

async function start(options: MoxyOptions = {}) {
  const moxy = await startMoxy({
    home: await temporaryHome(),
    clawPort: await freePort(),
    mcpPort: await freePort(),
    webPort: await freePort(),
    clawCli: FAKE_CLAW_CLI,
    leaders: () => echoLeader,
    workspace: '/work',
    log: silentLog,
    ...options,
  })
  running.push(moxy)
  return moxy
}

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

    const request = echoLeader.requests.at(-1)
    expect(request).toMatchObject({ cwd: '/work', mcp: { url: `http://127.0.0.1:${moxy.mcpPort}/mcp` } })
    const mcp = new Client({ name: 'test', version: '1' })
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(request!.mcp.url), {
        requestInit: { headers: { Authorization: `Bearer ${request!.mcp.token}` } },
      }),
    )
    expect((await mcp.listTools()).tools.map(tool => tool.name).sort()).toEqual([
      'accept',
      'delegate',
      'integrate',
      'message',
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
    const task = JSON.parse((created.content as { text: string }[])[0]?.text ?? '{}') as { id: string }
    await mcp.callTool({ name: 'ready', arguments: { task_id: task.id, how_to_try: 'Read them' } })
    expect(await mcp.callTool({ name: 'accept', arguments: { task_id: task.id } })).toMatchObject({
      isError: true,
      content: [{ text: 'only the user can accept a task, and this turn did not start from a user message' }],
    })
    expect(await mcp.callTool({ name: 'workers', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: '[]' }] })
    await mcp.close()
  })

  it('refuses the local API without its token', async () => {
    const moxy = await start()
    await expect(new MoxyClient(`http://127.0.0.1:${moxy.webPort}`, 'wrong').conversation()).rejects.toThrow('Unauthorized')
  })
})
