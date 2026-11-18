import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { expect, it } from 'vitest'

import type { SpawnPiped } from '../exec.js'
import { fakeAcpAgent } from '../testing/fake-acp-agent.js'
import { ACP_LEADERS, LeaderCatalog, mcpRemoteBridge, probeLeader } from './leaders.js'
import type { LeaderCheck } from './leaders.js'

it('runs Codex through the pinned codex-acp with Node, and agy through its own acp command', () => {
  expect(ACP_LEADERS.codex()).toMatchObject({ command: process.execPath, env: { NO_BROWSER: '1' } })
  expect(ACP_LEADERS.codex().args[0]).toMatch(/codex-acp[\\/]dist[\\/]index\.js$/)
  expect(ACP_LEADERS.agy()).toEqual({ command: 'agy', args: ['acp'] })
})

it("bridges Grip's MCP with the chat token in the environment, not the arguments", () => {
  const bridge = mcpRemoteBridge({ url: 'http://127.0.0.1:18797/mcp', token: 'secret-token' })
  expect(bridge).toMatchObject({
    name: 'grip',
    command: process.execPath,
    env: [{ name: 'GRIP_AUTHORIZATION', value: 'Bearer secret-token' }],
  })
  if (!('args' in bridge)) throw new Error('expected a stdio server')
  expect(bridge.args.slice(1)).toEqual([
    'http://127.0.0.1:18797/mcp',
    '--transport',
    'http-only',
    '--header',
    'Authorization:${GRIP_AUTHORIZATION}',
  ])
  expect(bridge.args.join(' ')).not.toContain('secret-token')
})

it('finds a leader available once it answers initialize, without opening a session', async () => {
  const fake = fakeAcpAgent()
  await expect(probeLeader({ command: 'agy', args: ['acp'] }, fake.spawn)).resolves.toEqual({ available: true })
  expect(fake.log.newSessions).toHaveLength(0)
  expect(fake.log.killed).toBe(1)
})

it('says why a leader is unavailable', async () => {
  const missing: SpawnPiped = () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    })
    setImmediate(() => child.emit('error', Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' })))
    return child as unknown as ChildProcessWithoutNullStreams
  }
  await expect(probeLeader({ command: 'agy', args: ['acp'] }, missing)).resolves.toEqual({
    available: false,
    reason: 'agy is not installed',
  })

  const silent: SpawnPiped = () =>
    Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    }) as never
  await expect(probeLeader({ command: 'kimi', args: ['acp'] }, silent, 30)).resolves.toEqual({
    available: false,
    reason: 'no answer within 0.03 s',
  })
})

it('offers Claude always, each ACP leader by its check and no other engine, checking a failed leader again', async () => {
  let agy: LeaderCheck = { available: false, reason: 'agy failed to start' }
  const probed: string[] = []
  const catalog = new LeaderCatalog(async engine => {
    probed.push(engine)
    if (engine === 'agy') return agy
    return engine === 'codex' ? { available: true } : { available: false, reason: `${engine} is not installed` }
  })
  const first = await catalog.list()
  expect(first.slice(0, 3)).toEqual([
    { engine: 'claude', available: true },
    { engine: 'codex', available: true },
    { engine: 'agy', available: false, reason: 'agy failed to start' },
  ])
  expect(first).toContainEqual({ engine: 'cursor', available: false, reason: "Can't lead a chat" })
  expect(first).toContainEqual({ engine: 'kimi', available: false, reason: 'kimi is not installed' })
  agy = { available: true }
  await expect(catalog.list()).resolves.toContainEqual({ engine: 'agy', available: true })
  await catalog.list()
  expect(probed).toEqual(['codex', 'agy', 'kimi', 'deepseek', 'codex', 'agy', 'kimi', 'deepseek'])
})
