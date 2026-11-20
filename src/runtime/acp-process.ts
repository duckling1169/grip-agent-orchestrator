// Uses the Agent Client Protocol TypeScript SDK: https://github.com/agentclientprotocol/typescript-sdk

import { Readable, Writable } from 'node:stream'
import { createRequire } from 'node:module'

import { ndJsonStream } from '@agentclientprotocol/sdk'

import { lastLine } from '../errors.js'
import { exec as defaultExec, spawnPiped } from '../exec.js'
import type { Exec, SpawnPiped } from '../exec.js'
import type { Engine } from '../contracts/engines.js'
import { requireDirectBinary } from './engines.js'

const require = createRequire(import.meta.url)

export const ACP_COMMANDS = {
  codex: (): AcpCommand => ({
    command: process.execPath,
    args: [require.resolve('@agentclientprotocol/codex-acp/dist/index.js')],
    env: { NO_BROWSER: '1' },
  }),
  agy: (): AcpCommand => ({ command: requireDirectBinary('agy'), args: ['acp'] }),
  kimi: (): AcpCommand => ({ command: requireDirectBinary('kimi'), args: ['acp'] }),
  deepseek: (): AcpCommand => ({ command: requireDirectBinary('deepseek'), args: ['--profile', 'acp'] }),
} satisfies Partial<Record<Engine, () => AcpCommand>>

export type AcpEngine = keyof typeof ACP_COMMANDS

export function isAcpEngine(engine: Engine): engine is AcpEngine {
  return Object.hasOwn(ACP_COMMANDS, engine)
}

export type AcpCommand = { command: string; args: readonly string[]; env?: Record<string, string> }

export type AcpProcessOptions = { spawn?: SpawnPiped; exec?: Exec }

export type AcpProcess = {
  stream: ReturnType<typeof ndJsonStream>
  failed: (during: string) => Promise<never>
  kill: () => void
}

export function startAcpProcess(agent: AcpCommand, cwd: string, options: AcpProcessOptions = {}): AcpProcess {
  const child = (options.spawn ?? spawnPiped)(agent.command, agent.args, { cwd, ...(agent.env ? { env: agent.env } : {}) })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-4000)))
  child.stdin.on('error', () => undefined)
  const exited = new Promise<number | null>(resolve => {
    child.on('close', code => resolve(code))
    child.on('error', () => resolve(null))
  })
  const spawnFailed = new Promise<never>((_, reject) => child.on('error', reject))
  spawnFailed.catch(() => undefined)
  return {
    stream: ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
    failed: during =>
      Promise.race([
        spawnFailed,
        exited.then(code => {
          throw new Error(`${agent.command} exited (${code ?? 'signal'}) ${during}${stderr ? `: ${lastLine(stderr)}` : ''}`)
        }),
      ]),
    kill: () => {
      if (child.exitCode !== null) return
      if (process.platform === 'win32' && child.pid !== undefined) {
        void (options.exec ?? defaultExec)('taskkill', ['/PID', String(child.pid), '/T', '/F']).catch(() => undefined)
      } else child.kill()
    },
  }
}
