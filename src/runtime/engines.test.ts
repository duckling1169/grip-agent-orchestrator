import { mkdir, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { temporaryHome } from '../testing/harness.js'
import { ACP_COMMANDS } from './acp-process.js'
import { canSpawnDirectly, isEngineInstalled } from './engines.js'
import { canRunLeader } from './leaders/runners.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

it.skipIf(process.platform !== 'win32')('accepts Windows shims for workers and requires native binaries for direct launches', async () => {
  const home = await temporaryHome()
  const other = join(home, 'other')
  await mkdir(other)
  await writeFile(join(home, 'codex.cmd'), '@echo off')
  await writeFile(join(home, 'grok.bat'), '@echo off')
  await mkdir(join(home, 'codex.exe'))
  vi.stubEnv('PATH', [home, other].join(delimiter))
  vi.stubEnv('PATHEXT', '.CMD;.BAT')
  expect((['codex', 'grok', 'opencode'] as const).filter(isEngineInstalled)).toEqual(['codex', 'grok'])
  expect(canSpawnDirectly('codex')).toBe(false)
  expect(canSpawnDirectly('grok')).toBe(false)
  await writeFile(join(other, 'codex.exe'), '')
  await writeFile(join(other, 'grok.com'), '')
  expect(canSpawnDirectly('codex')).toBe(true)
  expect(canSpawnDirectly('grok')).toBe(true)
})

it.skipIf(process.platform !== 'win32')('checks direct ACP commands while keeping Claw and bundled Codex leaders available', async () => {
  const home = await temporaryHome()
  for (const bin of ['claude', 'codex', 'agy', 'kimi', 'dsh']) await writeFile(join(home, `${bin}.cmd`), '@echo off')
  vi.stubEnv('PATH', home)
  expect(canRunLeader('claude')).toBe(true)
  expect(canRunLeader('codex')).toBe(true)
  expect(ACP_COMMANDS.codex().command).toBe(process.execPath)
  for (const [engine, bin] of [
    ['agy', 'agy'],
    ['kimi', 'kimi'],
    ['deepseek', 'dsh'],
  ] as const) {
    expect(canRunLeader(engine)).toBe(false)
    expect(() => ACP_COMMANDS[engine]()).toThrow(`put ${bin}.exe or ${bin}.com on PATH`)
    await writeFile(join(home, `${bin}.exe`), '')
    expect(canRunLeader(engine)).toBe(true)
    expect(ACP_COMMANDS[engine]().command).toBe(bin)
  }
})
