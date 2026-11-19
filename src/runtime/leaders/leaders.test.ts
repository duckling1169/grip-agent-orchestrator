import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FakeClaw } from '../../testing/fake-claw.js'
import { fakeAcpAgent } from '../../testing/fake-acp-agent.js'
import type { FakeAcpOptions } from '../../testing/fake-acp-agent.js'
import { temporaryHome } from '../../testing/harness.js'
import { AcpLeader } from './acp-leader.js'
import { ClawLeader, LEADER_SESSION } from './claw-leader.js'
import { LEADER_PROMPT } from './leader.js'
import type { LeaderTurnRequest } from './leader.js'
import { leaderRunners } from './runners.js'

const mcp = { url: 'http://127.0.0.1:18797/mcp', token: 'secret' }

function request(overrides: Partial<LeaderTurnRequest> = {}): LeaderTurnRequest {
  return {
    engine: 'claude',
    model: null,
    effort: null,
    nativeSessionId: null,
    cwd: '/work',
    message: 'Hello',
    mcp,
    timeoutMs: 60_000,
    ...overrides,
  }
}

describe('ClawLeader', () => {
  it('runs one turn with the moxy MCP server and closes the session', async () => {
    const claw = new FakeClaw()
    const configPath = join(await temporaryHome(), 'leader-mcp.json')
    const leader = new ClawLeader(claw, configPath)
    const reply = leader.run(request({ model: 'opus', nativeSessionId: 'native-0' }))
    await claw.turnStarted(LEADER_SESSION)
    claw.answer(LEADER_SESSION, { output: 'Hi.', sessionId: 'native-1', permissionDenials: [{ toolName: 'Bash' }] })

    expect(await reply).toEqual({ output: 'Hi.\n\n[moxy] 1 tool call(s) were denied: Bash', error: null, nativeSessionId: 'native-1' })
    expect(claw.starts[0]).toMatchObject({
      name: LEADER_SESSION,
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
    expect(claw.stops).toEqual([LEADER_SESSION])
  })

  it('returns a failure as a reply instead of throwing', async () => {
    const claw = new FakeClaw()
    const leader = new ClawLeader(claw, join(await temporaryHome(), 'leader-mcp.json'))
    const reply = leader.run(request())
    await claw.turnStarted(LEADER_SESSION)
    claw.fail(LEADER_SESSION, new Error('engine crashed'))
    expect(await reply).toEqual({ output: '', error: 'engine crashed', nativeSessionId: null })
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

  it('cancels a running turn on stop', async () => {
    const { leader, log } = leaderWith({ hang: true })
    const reply = leader.run(request({ engine: 'agy' }))
    while (log.prompts.length === 0) await new Promise(resolve => setTimeout(resolve, 5))
    await leader.stop()
    expect(await reply).toMatchObject({ error: 'stopped' })
    expect(log.cancelled).toBe(1)
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
