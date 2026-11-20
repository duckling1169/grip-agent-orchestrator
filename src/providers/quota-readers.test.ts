import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { spawnPiped } from '../exec.js'
import type { Exec } from '../exec.js'
import { temporaryHome } from '../testing/harness.js'
import { CliQuotaReaders, codexRpc } from './quota-readers.js'

const fakeServer = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url))
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const NOW = new Date('2026-11-17T22:00:00Z')

function fakeExec(answers: Record<string, { code?: number; stdout?: string; stderr?: string }>) {
  const calls: { command: string; args: readonly string[]; cwd: string | undefined }[] = []
  const run: Exec = async (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd })
    const a = answers[command]
    if (!a) throw new Error(`spawn ${command} ENOENT`)
    return { code: a.code ?? 0, stdout: a.stdout ?? '', stderr: a.stderr ?? '' }
  }
  return { run, calls }
}

describe('codexRpc', () => {
  it('initializes, skips notifications, and returns the answer', async () => {
    const result = await codexRpc(spawnPiped, process.execPath, [fakeServer], 'account/rateLimits/read', {})
    expect(result).toMatchObject({ rateLimits: { limitId: 'codex' } })
  })

  it('turns an error answer or an early exit into an error', async () => {
    await expect(codexRpc(spawnPiped, process.execPath, [fakeServer, '--fail'], 'account/rateLimits/read', {})).rejects.toThrow(
      'codex account/rateLimits/read: not signed in',
    )
    await expect(codexRpc(spawnPiped, process.execPath, [fakeServer, '--exit'], 'account/rateLimits/read', {})).rejects.toThrow(
      'codex app-server exited (3)',
    )
  })
})

describe('CliQuotaReaders', () => {
  it('reads Codex through the native binary when the npm entry point is unavailable', async () => {
    const { run } = fakeExec({ npm: { stdout: 'C:\\nowhere\\node_modules\n' } })
    const spawned: string[][] = []
    const readers = new CliQuotaReaders({
      exec: run,
      directBinary: engine => engine,
      now: () => NOW,
      spawn: (command, args) => {
        spawned.push([command, ...args])
        return spawnPiped(process.execPath, [fakeServer])
      },
    })
    const usage = await readers.codex()
    expect(spawned).toEqual([['codex', 'app-server']])
    expect(usage?.windows.map(w => w.name)).toEqual(['5h', 'week'])
  })

  it('runs the npm Codex entry point without looking for a native Codex binary', async () => {
    const npmRoot = await temporaryHome()
    const bin = join(npmRoot, '@openai', 'codex', 'bin')
    await mkdir(bin, { recursive: true })
    const cli = join(bin, 'codex.js')
    await writeFile(cli, '')
    const { run } = fakeExec({ npm: { stdout: npmRoot } })
    const spawn = vi.fn(() => spawnPiped(process.execPath, [fakeServer]))
    const readers = new CliQuotaReaders({
      exec: run,
      spawn,
      directBinary: () => {
        throw new Error('unexpected direct lookup')
      },
    })
    await readers.codex()
    expect(spawn).toHaveBeenCalledWith(process.execPath, [cli, 'app-server'], expect.anything())
  })

  it.skipIf(process.platform !== 'win32')('reports shim-only quota engines before attempting their commands', async () => {
    const home = await temporaryHome()
    for (const engine of ['agy', 'claude', 'codex']) await writeFile(join(home, `${engine}.cmd`), '@echo off')
    const { run, calls } = fakeExec({ npm: { stdout: home } })
    const spawn = vi.fn(() => {
      throw new Error('unexpected spawn')
    })
    vi.stubEnv('PATH', home)
    try {
      const readers = new CliQuotaReaders({ exec: run, spawn })
      for (const engine of ['agy', 'claude', 'codex'] as const) {
        await expect(readers[engine]()).rejects.toThrow(`put ${engine}.exe or ${engine}.com on PATH`)
      }
      expect(calls.map(call => call.command)).toEqual(['npm'])
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('runs agy /usage in an empty temporary folder', async () => {
    const { run, calls } = fakeExec({ agy: { stdout: fixture('agy-usage.json') } })
    const usage = await new CliQuotaReaders({ exec: run, now: () => NOW, directBinary: engine => engine }).agy()
    expect(usage?.windows).toHaveLength(5)
    expect(calls[0]?.args).toEqual(['-p', '/usage', '--output-format', 'json', '--print-timeout', '90s'])
    expect(calls[0]?.cwd).toMatch(/moxy-probe-/)
  })

  it('probes Claude on the cheapest model with no tools and no saved session', async () => {
    const { run, calls } = fakeExec({ claude: { stdout: fixture('claude-stream.jsonl') } })
    const usage = await new CliQuotaReaders({ exec: run, now: () => NOW, directBinary: engine => engine }).claude()
    expect(usage?.windows.map(w => w.name)).toEqual(['5h', 'week', 'opus'])
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['--model', 'haiku', '--tools', '', '--no-session-persistence']))
  })

  it('reports a failed command with its last stderr line', async () => {
    const { run } = fakeExec({ agy: { code: 1, stderr: 'starting\nnot signed in\n' } })
    await expect(new CliQuotaReaders({ exec: run, directBinary: engine => engine }).agy()).rejects.toThrow('agy /usage: not signed in')
  })
})
