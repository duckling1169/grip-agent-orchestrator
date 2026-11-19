import { describe, expect, it } from 'vitest'

import type { SessionConfigOption } from '@agentclientprotocol/sdk'

import { fakeAcpAgent } from '../testing/fake-acp-agent.js'
import { probeAcpModels, ModelCatalog } from './models.js'

const modelConfig: SessionConfigOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'a',
  options: [
    {
      group: 'available',
      name: 'Available',
      options: [
        { value: 'a', name: 'A' },
        { value: 'b', name: 'B' },
      ],
    },
  ],
}
const effort = (values: string[], currentValue: string): SessionConfigOption => ({
  id: 'effort',
  name: 'Effort',
  category: 'thought_level',
  type: 'select',
  currentValue,
  options: values.map(value => ({ value, name: value })),
})

describe('ACP model probe', () => {
  it('reads model-specific effort without prompting, denies permissions and terminates the process', async () => {
    const fake = fakeAcpAgent({
      configOptions: [modelConfig, effort(['low', 'high'], 'high')],
      configOptionsByModel: { b: [modelConfig, effort(['medium'], 'medium')] },
      permissionOnOpen: true,
    })
    expect(await probeAcpModels({ command: 'fake', args: [] }, { spawn: fake.spawn })).toEqual([
      { id: 'a', label: 'A', efforts: ['low', 'high'], defaultEffort: 'high', isDefault: true },
      { id: 'b', label: 'B', efforts: ['medium'], defaultEffort: 'medium', isDefault: false },
    ])
    expect(fake.log.prompts).toEqual([])
    expect(fake.log.configs).toEqual([{ configId: 'model', value: 'b' }])
    expect(fake.log.permission).toEqual({ outcome: 'cancelled' })
    expect(fake.log.killed).toBe(1)
    expect(fake.log.newSessions[0]?.mcpServers).toEqual([])
    expect(fake.log.newSessions[0]?.cwd).toMatch(/moxy-probe-/)
  })

  it('bounds a stalled session open and kills it', async () => {
    const fake = fakeAcpAgent({ hangOnOpen: true })
    await expect(probeAcpModels({ command: 'fake', args: [] }, { spawn: fake.spawn, timeoutMs: 20 })).rejects.toThrow('timed out')
    expect(fake.log.killed).toBe(1)
    expect(fake.log.prompts).toEqual([])
  })

  it('keeps the agent default usable when no model list is offered', async () => {
    const fake = fakeAcpAgent()
    expect(await probeAcpModels({ command: 'fake', args: [] }, { spawn: fake.spawn })).toEqual([])
    expect(fake.log.killed).toBe(1)
  })
})

describe('model catalog', () => {
  it('loads only the requested engine, coalesces requests, expires and refreshes its cache', async () => {
    let calls = 0
    let now = 0
    const catalog = new ModelCatalog({
      installed: () => true,
      now: () => now,
      cacheMs: 100,
      probe: async () => {
        calls++
        return []
      },
    })
    await Promise.all([catalog.get('codex'), catalog.get('codex')])
    expect(calls).toBe(1)
    await catalog.get('agy')
    expect(calls).toBe(2)
    now = 101
    await catalog.get('codex')
    expect(calls).toBe(3)
    await catalog.refresh('codex')
    expect(calls).toBe(4)
  })

  it('reports failed discovery and retries on the next request', async () => {
    let calls = 0
    const catalog = new ModelCatalog({
      installed: () => true,
      probe: async () => {
        if (++calls === 1) throw new Error('not authenticated')
        return []
      },
    })
    expect(await catalog.get('codex')).toEqual({ engine: 'codex', models: [], error: 'not authenticated' })
    expect(await catalog.get('codex')).toEqual({ engine: 'codex', models: [], error: null })
  })

  it('does not probe missing or non-ACP agents and provides Claude CLI aliases', async () => {
    const catalog = new ModelCatalog({
      installed: engine => engine !== 'codex',
      probe: async () => {
        throw new Error('unexpected probe')
      },
    })
    expect((await catalog.get('codex')).error).toMatch(/not installed/)
    expect(await catalog.get('cursor')).toEqual({ engine: 'cursor', models: [], error: null })
    expect((await catalog.get('claude')).models.map(model => model.id)).toEqual(['opus', 'sonnet', 'haiku'])
  })
})
