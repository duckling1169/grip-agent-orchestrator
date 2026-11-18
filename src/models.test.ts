import { expect, it } from 'vitest'

import { CLAUDE_MODELS, ModelCatalog, parseAgyModels, parseCodexModels } from './models.js'
import type { ModelReaders } from './models.js'

it('reads Codex models with their efforts and leaves hidden ones out', () => {
  const result = {
    data: [
      {
        id: 'gpt-a',
        model: 'gpt-a',
        displayName: 'GPT-A',
        hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
        defaultReasoningEffort: 'low',
        isDefault: true,
      },
      { id: 'gpt-old', model: 'gpt-old', displayName: 'Old', hidden: true },
    ],
  }
  expect(parseCodexModels(result)).toEqual([
    { id: 'gpt-a', label: 'GPT-A', efforts: ['low', 'high'], defaultEffort: 'low', isDefault: true },
  ])
  expect(() => parseCodexModels({})).toThrow('no model data')
})

it('reads agy models and skips its status line', () => {
  const stdout =
    'Fetching available models...\ngemini-4-argon-high\tGemini 4 Argon (High)\r\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\n\n'
  expect(parseAgyModels(stdout)).toEqual([
    { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)', efforts: [], defaultEffort: null, isDefault: false },
    { id: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)', efforts: [], defaultEffort: null, isDefault: false },
  ])
})

it('caches lists for an hour but retries a failed read on the next ask', async () => {
  let now = 0
  let codexReads = 0
  let agyFails = true
  const readers: ModelReaders = {
    codex: async () => {
      codexReads++
      return []
    },
    agy: async () => {
      if (agyFails) throw new Error('agy is not signed in')
      return []
    },
  }
  const catalog = new ModelCatalog(readers, () => now)
  const first = await catalog.list()
  expect(first).toEqual([
    { engine: 'claude', models: CLAUDE_MODELS, error: null },
    { engine: 'codex', models: [], error: null },
    { engine: 'agy', models: [], error: 'agy is not signed in' },
  ])
  await new Promise(resolve => setTimeout(resolve, 0))
  agyFails = false
  expect((await catalog.list())[2]?.error).toBeNull()
  expect(codexReads).toBe(2)
  await catalog.list()
  expect(codexReads).toBe(2)
  now += 61 * 60_000
  await catalog.list()
  expect(codexReads).toBe(3)
})
