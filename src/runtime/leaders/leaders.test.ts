import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FakeClaw } from '../../testing/fake-claw.js'
import type { ClawSendResult, StartSessionOptions } from '../claw/client.js'
import { fakeAcpAgent } from '../../testing/fake-acp-agent.js'
import type { FakeAcpOptions } from '../../testing/fake-acp-agent.js'
import { temporaryHome } from '../../testing/harness.js'
import { AcpLeader } from './acp-leader.js'
import { ClawLeader, LEADER_SESSION_PREFIX } from './claw-leader.js'
import type { LeaderTurnRequest } from './leader.js'
import { leaderRunners } from './runners.js'

const LEADER_PROMPT = 'You are Moxy.'
const mcp = { url: 'http://127.0.0.1:18797/mcp', token: 'secret' }

function request(overrides: Partial<LeaderTurnRequest> = {}): LeaderTurnRequest {
  return {
    engine: 'claude',
    model: null,
    effort: null,
    nativeSessionId: null,
    cwd: '/work',
    systemPrompt: LEADER_PROMPT,
    message: 'Hello',
    mcp,
    timeoutMs: 60_000,
    ...overrides,
  }
}

async function startedLeader(claw: FakeClaw, index = 0): Promise<string> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const name = claw.starts[index]?.name
    if (name) {
      await claw.turnStarted(name)
      return name
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('no leader session started')
}

describe('ClawLeader', () => {
  it('never implicitly resumes a crashed registry name and explicitly resumes only the returned native session', async () => {
    class RegistryClaw extends FakeClaw {
      readonly persisted = new Map([
        ['moxy-leader', 'crashed-native'],
        ['moxy-leader-turn-1', 'older-native'],
      ])
      override startSession(options: StartSessionOptions) {
        const resumeSessionId = options.resumeSessionId ?? this.persisted.get(options.name)
        return super.startSession({ ...options, ...(resumeSessionId ? { resumeSessionId } : {}) })
      }
      override answer(name: string, result: ClawSendResult) {
        if (result.sessionId) this.persisted.set(name, result.sessionId)
        super.answer(name, result)
      }
      override async stopSession(name: string) {
        await super.stopSession(name)
        this.persisted.delete(name)
      }
    }
    const claw = new RegistryClaw()
    const leader = new ClawLeader(claw, join(await temporaryHome(), 'leader-mcp.json'))
    const run = leader.run(request({ sessionKey: 'turn-1' }))
    await startedLeader(claw)
    const first = claw.starts[0]!
    claw.answer(first.name, { output: 'Fresh.', sessionId: 'new-native' })
    await run
    expect(first.resumeSessionId).toBeUndefined()
    const continuation = leader.run(request({ sessionKey: 'turn-1', nativeSessionId: 'new-native' }))
    await startedLeader(claw, 1)
    const second = claw.starts[1]!
    claw.answer(second.name, { output: 'Continued.', sessionId: 'new-native' })
    await continuation
    expect(second.name).not.toBe(first.name)
    expect(second.resumeSessionId).toBe('new-native')
    expect(claw.persisted.has(first.name)).toBe(false)
    expect(claw.persisted.has(second.name)).toBe(false)
  })

  it('runs one turn with the moxy MCP server and closes the session', async () => {
    const claw = new FakeClaw()
    const configPath = join(await temporaryHome(), 'leader-mcp.json')
    const leader = new ClawLeader(claw, configPath)
    const reply = leader.run(request({ model: 'opus', nativeSessionId: 'native-0' }))
    const name = await startedLeader(claw)
    claw.answer(name, { output: 'Hi.', sessionId: 'native-1', permissionDenials: [{ toolName: 'Bash' }] })

    expect(await reply).toEqual({ output: 'Hi.\n\n[moxy] 1 tool call(s) were denied: Bash', error: null, nativeSessionId: 'native-1' })
    expect(claw.starts[0]).toMatchObject({
      name: expect.stringMatching(new RegExp(`^${LEADER_SESSION_PREFIX}`)),
      model: 'opus',
      resumeSessionId: 'native-0',
      mcpConfig: configPath,
      allowedTools: ['mcp__moxy'],
      disallowedTools: ['Agent', 'Task'],
      appendSystemPrompt: LEADER_PROMPT,
    })
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      mcpServers: { moxy: { type: 'http', url: mcp.url, headers: { Authorization: 'Bearer secret' } } },
    })
    expect(claw.stops).toEqual([name])
  })

  it('returns a failure as a reply instead of throwing', async () => {
    const claw = new FakeClaw()
    const leader = new ClawLeader(claw, join(await temporaryHome(), 'leader-mcp.json'))
    const reply = leader.run(request())
    const name = await startedLeader(claw)
    claw.fail(name, new Error('engine crashed'))
    expect(await reply).toEqual({ output: '', error: 'engine crashed', nativeSessionId: null })
  })

  it('reports the returned native session without inventing context occupancy from billable usage', async () => {
    const claw = new FakeClaw()
    const leader = new ClawLeader(claw, join(await temporaryHome(), 'leader-mcp.json'))
    const pending = leader.run(request({ nativeSessionId: 'old-native' }))
    const name = await startedLeader(claw)
    const returned = { output: 'Done.', sessionId: 'actual-native', usage: { tokensIn: 900000, tokensOut: 10000, costUsd: 2 } }
    claw.answer(name, returned)
    expect(await pending).toEqual({ output: 'Done.', error: null, nativeSessionId: 'actual-native' })
  })

  it('stops the currently running unique transport session', async () => {
    const claw = new FakeClaw()
    const leader = new ClawLeader(claw, join(await temporaryHome(), 'leader-mcp.json'))
    const pending = leader.run(request({ sessionKey: 'turn-2' }))
    const name = await startedLeader(claw)
    await leader.stop()
    expect((await pending).error).toMatch(/stopped/)
    expect(claw.stops.length).toBeGreaterThan(0)
    expect(claw.stops.every(stopped => stopped === name)).toBe(true)
  })
})

describe('AcpLeader', () => {
  const leaderWith = (options: FakeAcpOptions = {}) => {
    const fake = fakeAcpAgent(options)
    return { ...fake, leader: new AcpLeader({ command: 'agent', args: ['acp'] }, { spawn: fake.spawn, stopGraceMs: 50 }) }
  }

  it('starts a new session, puts the prompt in the first message and bridges MCP over stdio', async () => {
    const { leader, log } = leaderWith({ reply: 'All good.' })
    expect(await leader.run(request({ engine: 'agy' }))).toEqual({ output: 'All good.', error: null, nativeSessionId: 'fake-1' })
    expect(log.spawned).toEqual([{ command: 'agent', args: ['acp'], cwd: '/work' }])
    expect(log.prompts[0]?.text).toBe(`${LEADER_PROMPT}\n\nHello`)
    expect(log.newSessions[0]?.mcpServers[0]).toMatchObject({ name: 'moxy', env: [{ name: 'MOXY_AUTHORIZATION', value: 'Bearer secret' }] })
    expect(log.killed).toBe(1)
  })

  it('loads the earlier session over HTTP MCP with an appended system prompt', async () => {
    const { leader, log } = leaderWith({ http: true, loadSession: true, systemPrompt: true, reply: 'Again.' })
    const reply = await leader.run(request({ engine: 'codex', nativeSessionId: 'native-7' }))
    expect(reply).toEqual({ output: 'Again.', error: null, nativeSessionId: 'native-7' })
    expect(log.loads).toMatchObject([{ sessionId: 'native-7', systemPrompt: `append: ${LEADER_PROMPT}` }])
    expect(log.loads[0]?.mcpServers[0]).toEqual({
      type: 'http',
      name: 'moxy',
      url: mcp.url,
      headers: [{ name: 'Authorization', value: 'Bearer secret' }],
    })
    expect(log.prompts[0]?.text).toBe('Hello')
  })

  it.each([{ loadSession: true, failLoadSession: true }, { loadSession: false }])(
    'restores task records and history when a native session cannot be loaded: %j',
    async options => {
      const { leader, log } = leaderWith(options)
      const freshContext = 'Task: preserve the agreed plan.\nRecent user message: keep the requested test coverage.'
      expect(await leader.run(request({ engine: 'codex', nativeSessionId: 'lost-session', freshContext }))).toMatchObject({
        error: null,
        nativeSessionId: 'fake-1',
      })
      expect(log.prompts[0]?.text).toBe(`${LEADER_PROMPT}\n\n${freshContext}\n\nHello`)
      expect(log.prompts).toHaveLength(1)
      expect(log.newSessions).toHaveLength(1)
    },
  )

  it('does not duplicate fresh context when the initial message is already seeded', async () => {
    const { leader, log } = leaderWith()
    await leader.run(request({ engine: 'codex', message: 'Task context\n\nHello', freshContext: 'Task context' }))
    expect(log.prompts[0]?.text).toBe(`${LEADER_PROMPT}\n\nTask context\n\nHello`)
  })

  it('chooses the model and refuses one the agent does not offer', async () => {
    const configOptions = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select' as const,
        currentValue: 'a',
        options: [
          { value: 'a', name: 'A' },
          { value: 'b', name: 'B' },
        ],
      },
    ]
    const chosen = leaderWith({ configOptions })
    await chosen.leader.run(request({ engine: 'kimi', model: 'b' }))
    expect(chosen.log.configs).toEqual([{ configId: 'model', value: 'b' }])

    const refused = leaderWith({ configOptions })
    expect((await refused.leader.run(request({ engine: 'kimi', model: 'c' }))).error).toBe('kimi has no model "c"; it offers a, b')
  })

  it('allows tool permissions and keeps text after a tool call as its own paragraph', async () => {
    const { leader, log } = leaderWith({ askPermission: true, toolCallFirst: true, reply: 'Looks fine.' })
    expect((await leader.run(request({ engine: 'agy' }))).output).toBe('Checking the diff.\n\nLooks fine.')
    expect(log.permission).toEqual({ outcome: 'selected', optionId: 'yes' })
  })

  it('chooses effort from the selected model configuration', async () => {
    const model = {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select' as const,
      currentValue: 'a',
      options: [
        { value: 'a', name: 'A' },
        { value: 'b', name: 'B' },
      ],
    }
    const effort = (value: string) => ({
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select' as const,
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value, name: value },
      ],
    })
    const { leader, log } = leaderWith({ configOptions: [model, effort('high')], configOptionsByModel: { b: [model, effort('medium')] } })
    expect((await leader.run(request({ engine: 'codex', model: 'b', effort: 'medium' }))).error).toBeNull()
    expect(log.configs).toEqual([
      { configId: 'model', value: 'b' },
      { configId: 'effort', value: 'medium' },
    ])
  })

  it('cancels a running turn on stop', async () => {
    const { leader, log } = leaderWith({ hang: true })
    const reply = leader.run(request({ engine: 'agy' }))
    while (log.prompts.length === 0) await new Promise(resolve => setTimeout(resolve, 5))
    await leader.stop()
    expect(await reply).toMatchObject({ error: 'stopped' })
    expect(log.cancelled).toBe(1)
  })

  it('reports official context occupancy for this session without treating usage as a text separator', async () => {
    const { leader } = leaderWith({ usageUpdates: [{ used: 900, size: 1000 }], reply: 'Done.' })
    expect(await leader.run(request({ engine: 'codex' }))).toEqual({
      output: 'Done.',
      error: null,
      nativeSessionId: 'fake-1',
      context: { used: 900, limit: 1000 },
    })
  })

  it('ignores invalid or foreign session usage instead of inventing context limits', async () => {
    const { leader } = leaderWith({
      usageUpdates: [
        { used: 4, size: 0 },
        { used: -1, size: 100 },
        { used: 90, size: 100, sessionId: 'other' },
      ],
    })
    expect(await leader.run(request({ engine: 'codex' }))).not.toHaveProperty('context')
  })
})

describe('leaderRunners', () => {
  it('uses Claw for Claude, ACP for ACP agents and refuses the rest', () => {
    const claude = new ClawLeader(new FakeClaw(), 'unused')
    const runners = leaderRunners(claude)
    expect(runners('claude')).toBe(claude)
    expect(runners('codex')).toBeInstanceOf(AcpLeader)
    expect(runners('codex')).toBe(runners('codex'))
    expect(() => runners('cursor')).toThrow('cannot lead Moxy')
  })
})
