import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { exec as defaultExec, execOk, spawnPiped as defaultSpawn } from '../exec.js'
import type { Exec, SpawnPiped } from '../exec.js'
import { parseAgyUsage, parseClaudeRateLimit, parseCodexRateLimits } from './parse.js'
import type { ProviderUsage } from './usage.js'

/** One reading per provider, each through its own official interface. Null means it gave no windows. */
export interface QuotaReaders {
  /** Codex app-server `account/rateLimits/read`: an account read, no quota spent. */
  codex(): Promise<ProviderUsage | null>
  /** `agy -p /usage`: a built-in command, no model turn. */
  agy(): Promise<ProviderUsage | null>
  /** A one-line Claude turn on the cheapest model, read for its `rate_limit_event`. Spends a little quota. */
  claude(): Promise<ProviderUsage | null>
}

const CODEX_TIMEOUT_MS = 30_000
const AGY_TIMEOUT_MS = 100_000
const CLAUDE_TIMEOUT_MS = 120_000
const CLAUDE_PROBE_MODEL = 'haiku'
const CLAUDE_PROBE_PROMPT = 'Reply with OK.'

export type CliQuotaReadersOptions = { exec?: Exec; spawn?: SpawnPiped; now?: () => Date }

export class CliQuotaReaders implements QuotaReaders {
  private readonly run: Exec
  private readonly spawn: SpawnPiped
  private readonly now: () => Date
  private codexCommand: Promise<[string, string[]]> | null = null

  constructor(options: CliQuotaReadersOptions = {}) {
    this.run = options.exec ?? defaultExec
    this.spawn = options.spawn ?? defaultSpawn
    this.now = options.now ?? (() => new Date())
  }

  private resolveCodex(): Promise<[string, string[]]> {
    this.codexCommand ??= codexCli(this.run)
    return this.codexCommand
  }

  async codex(): Promise<ProviderUsage | null> {
    const [command, prefix] = await this.resolveCodex()
    const result = await codexRpc(this.spawn, command, [...prefix, 'app-server'], 'account/rateLimits/read', {
      excludeResetCreditDetails: true,
    })
    return parseCodexRateLimits(result, this.now().toISOString())
  }

  async agy(): Promise<ProviderUsage | null> {
    const out = await inTempFolder(cwd =>
      this.run('agy', ['-p', '/usage', '--output-format', 'json', '--print-timeout', '90s'], { timeoutMs: AGY_TIMEOUT_MS, cwd }),
    )
    const usage = parseAgyUsage(out.stdout, this.now().toISOString())
    if (!usage && out.code !== 0) throw new Error(`agy /usage: ${lastLine(out.stderr) || `exit ${out.code}`}`)
    return usage
  }

  async claude(): Promise<ProviderUsage | null> {
    const args = [
      '-p',
      CLAUDE_PROBE_PROMPT,
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      CLAUDE_PROBE_MODEL,
      '--tools',
      '',
      '--strict-mcp-config',
      '--no-session-persistence',
    ]
    const out = await inTempFolder(cwd => this.run('claude', args, { timeoutMs: CLAUDE_TIMEOUT_MS, cwd }))
    const usage = parseClaudeRateLimit(out.stdout, this.now().toISOString())
    if (!usage && out.code !== 0) throw new Error(`claude probe: ${lastLine(out.stderr) || `exit ${out.code}`}`)
    return usage
  }
}

/**
 * The standalone Codex CLI from npm, run with Node. On Windows the first `codex` on PATH can be
 * the desktop app's bundled binary, which is not a usable CLI.
 */
export function codexCli(run: Exec): Promise<[string, string[]]> {
  return execOk(run, 'npm', ['root', '-g'], 30_000).then(
    out => {
      const cli = join(out.trim(), '@openai', 'codex', 'bin', 'codex.js')
      return existsSync(cli) ? [process.execPath, [cli]] : ['codex', []]
    },
    () => ['codex', []],
  )
}

const lastLine = (text: string) => text.trim().split(/\r?\n/).pop() ?? ''

/** Probes run in an empty folder, so no project settings, instructions or files come along. */
async function inTempFolder<T>(work: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'grip-quota-'))
  try {
    return await work(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * One request to a short-lived Codex app-server: `initialize`, `initialized`, the request, then
 * exit. Messages are JSON lines on stdio. Grip keeps its own client because Claw's app-server
 * connection belongs to a run's turn.
 */
export function codexRpc(spawn: SpawnPiped, command: string, args: readonly string[], method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args)
    let buffer = ''
    let stderr = ''
    let settled = false
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdin.end()
      child.kill()
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error(`codex ${method}: no answer within ${CODEX_TIMEOUT_MS / 1000} s`)), CODEX_TIMEOUT_MS)
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)

    child.on('error', error => finish(error))
    child.on('close', code => finish(new Error(`codex app-server exited (${code ?? 'signal'}) before answering: ${lastLine(stderr)}`)))
    child.stdin.on('error', () => undefined)
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-4000)))
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        let message: { id?: unknown; result?: unknown; error?: { message?: unknown } }
        try {
          message = JSON.parse(line) as typeof message
        } catch {
          continue
        }
        if (message.error && (message.id === 1 || message.id === 2)) {
          const reason = typeof message.error.message === 'string' ? message.error.message : JSON.stringify(message.error)
          return finish(new Error(`codex ${message.id === 1 ? 'initialize' : method}: ${reason}`))
        }
        if (message.id === 1) {
          send({ method: 'initialized' })
          send({ id: 2, method, params })
        } else if (message.id === 2) {
          return finish(null, message.result)
        }
      }
    })

    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'grip', title: 'Grip', version: '0.0.0' }, capabilities: null } })
  })
}
