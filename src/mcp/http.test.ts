import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'

import { Worktrees } from '../git/worktrees.js'
import { RunManager } from '../runs/manager.js'
import { RunStore } from '../runs/store.js'
import { FakeClaw } from '../testing/fake-claw.js'
import { startMcpHttp } from './http.js'

const TOKEN = 'b'.repeat(64)
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function setup() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'grip-mcp-')))
  const folder = join(base, 'notes')
  await mkdir(folder)
  const claw = new FakeClaw()
  const manager = new RunManager({ store: await RunStore.open(join(base, 'home')), worktrees: new Worktrees(), claw })
  const http = await startMcpHttp({ manager, token: TOKEN, port: 0 })
  cleanups.push(() => rm(base, { recursive: true, force: true }), http.close)
  const url = new URL(`http://127.0.0.1:${http.port}/mcp`)
  const client = new Client({ name: 'test-orchestrator', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }))
  cleanups.push(() => client.close())
  return { url, folder, claw, client }
}

const json = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0]!.text)

describe('Grip MCP over HTTP', () => {
  it('lists the orchestrator tools', async () => {
    const { client } = await setup()
    const names = (await client.listTools()).tools.map(t => t.name).sort()
    expect(names).toEqual(['delegate', 'list', 'message', 'result', 'stop', 'wait_any'])
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
    expect(done.turns).toEqual([{ turn: 1, message: 'Say hi', output: 'hi' }])

    const listed = json(await client.callTool({ name: 'list', arguments: { status: 'done' } }))
    expect(listed.map((r: { id: string }) => r.id)).toEqual([run.id])
    expect(json(await client.callTool({ name: 'wait_any', arguments: { timeout_sec: 0 } }))).toBeNull()
  })

  it('reports tool errors as errors, not crashes', async () => {
    const { client } = await setup()
    const result = await client.callTool({ name: 'message', arguments: { run_id: 'r-nope', text: 'x' } })
    expect(result.isError).toBe(true)
    expect((result.content as { text: string }[])[0]!.text).toContain('unknown run r-nope')
  })

  it('refuses requests without the token or with a foreign Host', async () => {
    const { url } = await setup()
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(401)
    expect((await fetch(url, { method: 'POST', headers: { ...headers, Authorization: 'Bearer wrong' }, body })).status).toBe(401)
    // fetch drops a custom Host header, so this one goes out through node:http.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${TOKEN}`, Host: 'evil.example' } }, res => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', reject)
      req.end(body)
    })
    expect(status).toBe(403)
  })
})
