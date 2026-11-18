import { expect, it } from 'vitest'

import { fakeAcpAgent } from '../testing/fake-acp-agent.js'
import type { FakeAcpOptions } from '../testing/fake-acp-agent.js'
import { AcpChatTurns } from './acp-turns.js'
import type { Chat } from './store.js'
import { HOSTED_CHAT_PROMPT } from './turns.js'
import type { TurnInput } from './turns.js'

const MCP = { url: 'http://127.0.0.1:18797/mcp', token: 'chat-token' }

const chat = (fields: Partial<Chat> = {}): Chat => ({
  id: 'c-1',
  kind: 'grip',
  title: 'Chat',
  engine: 'agy',
  model: null,
  effort: null,
  folder: '/work/repo',
  host: null,
  session: 'grip-c-1',
  engineSessionId: null,
  status: 'working',
  error: null,
  turns: 1,
  fromGrip: [],
  waiting: false,
  createdAt: '2026-11-18T00:00:00.000Z',
  updatedAt: '2026-11-18T00:00:00.000Z',
  ...fields,
})

function setup(options: FakeAcpOptions = {}) {
  const fake = fakeAcpAgent(options)
  const turns = new AcpChatTurns(
    { command: 'agy', args: ['acp'] },
    {
      spawn: fake.spawn,
      stopGraceMs: 50,
      bridge: mcp => ({ name: 'grip', command: 'bridge', args: [mcp.url], env: [{ name: 'GRIP_TOKEN', value: mcp.token }] }),
    },
  )
  const input = (fields: Partial<TurnInput> = {}): TurnInput => ({
    chat: chat(),
    message: 'Fix the bug',
    mcp: MCP,
    chatDir: '/home/chats/c-1',
    timeoutMs: 10_000,
    stopped: () => false,
    ...fields,
  })
  return { turns, log: fake.log, input }
}

it('starts a session with Grip over HTTP, tells a new conversation about Grip and collects the reply', async () => {
  const { turns, log, input } = setup({ http: true, reply: 'All fixed.', askPermission: true })
  await expect(turns.run(input())).resolves.toEqual({ output: 'All fixed.', error: null, sessionId: 'fake-1' })
  expect(log.spawned).toEqual([{ command: 'agy', args: ['acp'], cwd: '/work/repo' }])
  expect(log.newSessions).toEqual([
    {
      cwd: '/work/repo',
      mcpServers: [{ type: 'http', name: 'grip', url: MCP.url, headers: [{ name: 'Authorization', value: 'Bearer chat-token' }] }],
    },
  ])
  expect(log.prompts[0]?.text).toBe(`${HOSTED_CHAT_PROMPT}\n\nFix the bug`)
  expect(log.permission).toEqual({ outcome: 'selected', optionId: 'yes' })
  expect(log.killed).toBe(1)
})

it('reaches Grip through the stdio bridge when the agent takes no HTTP servers', async () => {
  const { turns, log, input } = setup({ http: false })
  await turns.run(input())
  expect(log.newSessions[0]?.mcpServers).toEqual([
    { name: 'grip', command: 'bridge', args: [MCP.url], env: [{ name: 'GRIP_TOKEN', value: 'chat-token' }] },
  ])
})

it('loads the earlier conversation and counts only the new reply', async () => {
  const { turns, log, input } = setup({ http: true, loadSession: true, reply: 'Second reply.' })
  const result = await turns.run(input({ chat: chat({ engineSessionId: 'conv-1' }), message: 'And now?' }))
  expect(result).toEqual({ output: 'Second reply.', error: null, sessionId: 'conv-1' })
  expect(log.loads).toHaveLength(1)
  expect(log.newSessions).toHaveLength(0)
  expect(log.prompts[0]?.text).toBe('And now?')
})

it("chooses the chat's model and effort through the agent's session options", async () => {
  const select = (id: string, category: string, values: string[]) => ({
    id,
    name: id,
    category,
    type: 'select' as const,
    currentValue: values[0]!,
    options: values.map(value => ({ value, name: value })),
  })
  const { turns, log, input } = setup({
    http: true,
    configOptions: [select('model', 'model', ['flash', 'pro']), select('effort', 'thought_level', ['low', 'high'])],
  })
  await turns.run(input({ chat: chat({ model: 'pro', effort: 'high' }) }))
  expect(log.configs).toEqual([
    { configId: 'model', value: 'pro' },
    { configId: 'effort', value: 'high' },
  ])

  const unknown = await turns.run(input({ chat: chat({ model: 'ultra' }) }))
  expect(unknown.error).toBe('agy has no model "ultra"; it offers flash, pro')
})

it('cancels a working turn when the chat is stopped', async () => {
  const { turns, log, input } = setup({ http: true, hang: true })
  const running = turns.run(input())
  await expect.poll(() => log.prompts.length).toBe(1)
  await expect(turns.stop(chat())).resolves.toBe(true)
  await expect(running).resolves.toMatchObject({ error: 'stopped' })
  expect(log.cancelled).toBe(1)
})

it('fails a turn that runs past its time limit', async () => {
  const { turns, input } = setup({ http: true, hang: true })
  await expect(turns.run(input({ timeoutMs: 50 }))).resolves.toMatchObject({ error: 'no reply within 0 minutes' })
})
