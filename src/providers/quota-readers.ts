import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { exec as defaultExec, execOk, spawnPiped as defaultSpawn } from '../exec.js'
import type { Exec, SpawnPiped } from '../exec.js'
import { parseAgyUsage, parseClaudeRateLimit, parseCodexRateLimits } from './quota-parse.js'
import type { EngineUsage } from '../contracts/api.js'
import { inTempFolder } from '../files.js'
import { lastLine } from '../errors.js'

export const QUOTA_ENGINES = ['codex', 'agy', 'claude'] as const
export type QuotaEngine = (typeof QUOTA_ENGINES)[number]

export interface QuotaReaders {
  codex(): Promise<EngineUsage | null>
  agy(): Promise<EngineUsage | null>
  claude(): Promise<EngineUsage | null>
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

  async codex(): Promise<EngineUsage | null> {
    const [command, prefix] = await this.resolveCodex()
    const result = await inTempFolder(cwd =>
      codexRpc(
        this.spawn,
        command,
        [...prefix, 'app-server'],
        'account/rateLimits/read',
        {
          excludeResetCreditDetails: true,
        },
        cwd,
      ),
    )
    return parseCodexRateLimits(result, this.now().toISOString())
  }

  async agy(): Promise<EngineUsage | null> {
    const out = await inTempFolder(cwd =>
      this.run('agy', ['-p', '/usage', '--output-format', 'json', '--print-timeout', '90s'], { timeoutMs: AGY_TIMEOUT_MS, cwd }),
    )
    const usage = parseAgyUsage(out.stdout, this.now().toISOString())
    if (!usage && out.code !== 0) throw new Error(`agy /usage: ${lastLine(out.stderr) || `exit ${out.code}`}`)
    return usage
  }

  async claude(): Promise<EngineUsage | null> {
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

export function codexCli(run: Exec): Promise<[string, string[]]> {
  return execOk(run, 'npm', ['root', '-g'], 30_000).then(
    out => {
      const cli = join(out.trim(), '@openai', 'codex', 'bin', 'codex.js')
      return existsSync(cli) ? [process.execPath, [cli]] : ['codex', []]
    },
    () => ['codex', []],
  )
}

export function codexRpc(
  spawn: SpawnPiped,
  command: string,
  args: readonly string[],
  method: string,
  params: unknown,
  cwd?: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, cwd ? { cwd } : {})
    let buffer = ''
    let stderr = ''
    let settled = false
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdin.end()
      const stop =
        process.platform === 'win32' && child.pid !== undefined && child.exitCode === null
          ? defaultExec('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeoutMs: 5000 }).then(() => undefined)
          : Promise.resolve()
      void stop
        .catch(() => undefined)
        .finally(() => {
          if (child.exitCode === null) child.kill()
          if (error) reject(error)
          else resolve(value)
        })
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

    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'moxy', title: 'Moxy', version: '0.0.0' }, capabilities: null } })
  })
}
