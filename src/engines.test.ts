import { expect, it } from 'vitest'

import { ENGINE_SPECS, EngineCatalog, ENGINES, onPath } from './engines.js'
import { withInstalledEngines } from './models.js'

it('finds a command on PATH, with PATHEXT on Windows', () => {
  const files = new Set(['/usr/local/bin/kimi', 'C:\\tools\\dsh.CMD'])
  const exists = (path: string) => files.has(path)
  expect(onPath('kimi', { PATH: '/usr/bin:/usr/local/bin' }, exists, 'linux')).toBe(true)
  expect(onPath('dsh', { PATH: '/usr/bin:/usr/local/bin' }, exists, 'linux')).toBe(false)
  expect(onPath('dsh', { Path: 'C:\\Windows;C:\\tools', PATHEXT: '.EXE;.CMD' }, exists, 'win32')).toBe(true)
  expect(onPath('kimi', { Path: 'C:\\tools', PATHEXT: '.EXE;.CMD' }, exists, 'win32')).toBe(false)
})

it('offers every engine Claw runs, each with the CLI it needs', () => {
  expect(ENGINES).toEqual(['claude', 'codex', 'agy', 'gemini', 'cursor', 'grok', 'opencode', 'kimi', 'deepseek'])
  expect(ENGINE_SPECS.deepseek).toMatchObject({ claw: 'acp', acpAgent: 'dsh', bin: 'dsh' })
  expect(ENGINE_SPECS.codex).toMatchObject({ claw: 'codex-app', bin: 'codex' })
})

it('says which engines are installed, and lists the others with no models of their own', async () => {
  const looked: string[] = []
  const catalog = new EngineCatalog(bin => (looked.push(bin), ['claude', 'codex', 'agy', 'kimi'].includes(bin)))
  expect(catalog.isInstalled('kimi')).toBe(true)
  expect(catalog.isInstalled('cursor')).toBe(false)
  expect(catalog.list()).toContainEqual({ engine: 'cursor', name: 'Cursor', installed: false })
  // Looked up once, then kept.
  expect(looked).toHaveLength(ENGINES.length)

  const models = withInstalledEngines({ list: async () => [{ engine: 'codex', models: [], error: null }] }, catalog)
  await expect(models.list()).resolves.toEqual([
    { engine: 'codex', models: [], error: null },
    { engine: 'claude', models: [], error: null },
    { engine: 'agy', models: [], error: null },
    { engine: 'kimi', models: [], error: null },
  ])
})
