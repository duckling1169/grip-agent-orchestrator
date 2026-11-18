import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { ClawClient } from './client.js'
import { gateSummary, healthGate } from './gate.js'

const TOKEN = 'a'.repeat(64)

/** Just enough of Claw's HTTP API: /health open, the session routes behind the bearer token. */
function fakeClaw(opts: { version?: string; brokenShape?: boolean; refuseEngine?: string } = {}) {
  const sessions = new Map<string, Record<string, unknown>>()
  const server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.url === '/health') return reply(200, { ok: true, version: opts.version ?? '7.23.4', sessions: sessions.size })
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { ok: false, error: 'Unauthorized' })
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, string>) : {}
      if (req.url === '/session/list') return reply(200, { ok: true, sessions: [...sessions.values()] })
      if (req.url === '/session/start') {
        if (body.engine === opts.refuseEngine) return reply(500, { ok: false, error: 'Internal error' })
        const info = opts.brokenShape
          ? { name: body.name, cwd: body.cwd, created: 'x', stats: {} }
          : { name: body.name, cwd: body.cwd, created: new Date().toISOString(), paused: false, stats: { turns: 0 } }
        sessions.set(body.name!, info)
        return reply(200, { ok: true, ...info })
      }
      if (req.url === '/session/stop') {
        sessions.delete(body.name!)
        return reply(200, { ok: true })
      }
      reply(404, { ok: false, error: 'not found' })
    })
  })
  return new Promise<{ client: ClawClient; sessions: typeof sessions; close: () => void }>(resolve =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ client: new ClawClient(`http://127.0.0.1:${port}`, TOKEN), sessions, close: () => server.close() })
    }),
  )
}

let close: (() => void) | null = null
afterEach(() => close?.())

describe('healthGate', () => {
  it('passes a healthy Claw and leaves no sessions behind', async () => {
    const claw = await fakeClaw()
    close = claw.close
    const result = await healthGate({ client: claw.client, expectedVersion: '7.23.4', engines: ['claude', 'codex-app', 'agy'], cwd: '/tmp' })
    expect(result.ok).toBe(true)
    expect(gateSummary(result)).toBe('all checks passed')
    expect(result.checks.map(c => c.name)).toContain('agy session stop')
    expect(claw.sessions.size).toBe(0)
  })

  it('fails on a version mismatch', async () => {
    const claw = await fakeClaw({ version: '7.24.0' })
    close = claw.close
    const result = await healthGate({ client: claw.client, expectedVersion: '7.23.4', engines: [], cwd: '/tmp' })
    expect(result.ok).toBe(false)
    expect(gateSummary(result)).toContain('version')
  })

  it('fails when session fields Grip reads have changed', async () => {
    const claw = await fakeClaw({ brokenShape: true })
    close = claw.close
    const result = await healthGate({ client: claw.client, expectedVersion: '7.23.4', engines: ['claude'], cwd: '/tmp' })
    expect(result.ok).toBe(false)
    expect(gateSummary(result)).toContain('stats.turns')
    expect(claw.sessions.size).toBe(0)
  })

  it('fails when an engine cannot open a session', async () => {
    const claw = await fakeClaw({ refuseEngine: 'agy' })
    close = claw.close
    const result = await healthGate({ client: claw.client, expectedVersion: '7.23.4', engines: ['claude', 'agy'], cwd: '/tmp' })
    expect(result.ok).toBe(false)
    expect(result.checks.find(c => c.name === 'agy session start')?.ok).toBe(false)
    expect(result.checks.find(c => c.name === 'claude session stop')?.ok).toBe(true)
  })

  it('fails fast when nothing answers', async () => {
    const result = await healthGate({ client: new ClawClient('http://127.0.0.1:9', TOKEN), expectedVersion: '7.23.4', engines: ['claude'], cwd: '/tmp' })
    expect(result).toEqual({ ok: false, checks: [{ name: 'health', ok: false, detail: 'no answer on /health' }] })
  })
})

describe('ClawClient', () => {
  it('sends the bearer token and surfaces Claw errors', async () => {
    const claw = await fakeClaw({ refuseEngine: 'claude' })
    close = claw.close
    await expect(claw.client.listSessions()).resolves.toEqual([])
    await expect(claw.client.startSession({ name: 'x', cwd: '/tmp', engine: 'claude' })).rejects.toThrow('/session/start: Internal error')
    const anonymous = new ClawClient(claw.client.baseUrl, 'wrong')
    await expect(anonymous.listSessions()).rejects.toThrow('Unauthorized')
  })
})
