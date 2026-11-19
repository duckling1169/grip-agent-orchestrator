import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { spawnPiped } from '../exec.js'
import type { Exec } from '../exec.js'
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
  it('reads Codex through the npm CLI when npm has it, else codex on PATH', async () => {
    const { run } = fakeExec({ npm: { stdout: 'C:\\nowhere\\node_modules\n' } })
    const spawned: string[][] = []
    const readers = new CliQuotaReaders({
      exec: run,
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

  it('runs agy /usage in an empty temporary folder', async () => {
    const { run, calls } = fakeExec({ agy: { stdout: fixture('agy-usage.json') } })
    const usage = await new CliQuotaReaders({ exec: run, now: () => NOW }).agy()
    expect(usage?.windows).toHaveLength(5)
    expect(calls[0]?.args).toEqual(['-p', '/usage', '--output-format', 'json', '--print-timeout', '90s'])
    expect(calls[0]?.cwd).toMatch(/moxy-probe-/)
  })

  it('probes Claude on the cheapest model with no tools and no saved session', async () => {
    const { run, calls } = fakeExec({ claude: { stdout: fixture('claude-stream.jsonl') } })
    const usage = await new CliQuotaReaders({ exec: run, now: () => NOW }).claude()
    expect(usage?.windows.map(w => w.name)).toEqual(['5h', 'week', 'opus'])
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['--model', 'haiku', '--tools', '', '--no-session-persistence']))
  })

  it('reports a failed command with its last stderr line', async () => {
    const { run } = fakeExec({ agy: { code: 1, stderr: 'starting\nnot signed in\n' } })
    await expect(new CliQuotaReaders({ exec: run }).agy()).rejects.toThrow('agy /usage: not signed in')
  })
})
