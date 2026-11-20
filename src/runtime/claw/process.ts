import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { closeSync, openSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

import { exec as defaultExec } from '../../exec.js'
import type { Exec } from '../../exec.js'
import { writeFileAtomic } from '../../files.js'
import { rotateIfLarge } from '../../log.js'
import { settlesWithin } from '../deadline.js'
import type { ClawClient } from './client.js'

export type ClawProcessOptions = {
  client: ClawClient
  cliPath: string
  port: number
  logFile: string
  env?: NodeJS.ProcessEnv
  healthTimeoutMs?: number
  restartDelaysMs?: readonly number[]
  stableAfterMs?: number
  exec?: Exec
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  stopTimeoutMs?: number
}

export type ClawProcessEvents = {
  started: [{ pid: number; version: string }]
  crashed: [{ code: number | null; signal: NodeJS.Signals | null; restartInMs: number }]
  restartFailed: [Error]
}

const DEFAULT_RESTART_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000, 60_000]
const STOP_TIMEOUT_MS = 10_000

export class ClawProcess extends EventEmitter<ClawProcessEvents> {
  private child: ChildProcess | null = null
  private stopping = false
  private starting = false
  private consecutiveCrashes = 0
  private restartTimer: NodeJS.Timeout | null = null
  private stableTimer: NodeJS.Timeout | null = null

  constructor(private readonly options: ClawProcessOptions) {
    super()
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null
  }

  async start(reconcile?: (version: string) => Promise<void>): Promise<{ version: string }> {
    if (this.running) throw new Error('Claw is already running')
    this.stopping = false
    const existing = await this.options.client.health(1000)
    if (existing) {
      const pid = reconcile && (await this.recoveryPid())
      if (!pid || !reconcile) throw new Error(`port ${this.options.port} already answers as Claw; stop that server first`)
      await reconcile(existing.version)
      await this.stopRecovered(pid)
    }
    if (this.stopping) throw new Error('Claw start was stopped')
    rotateIfLarge(this.options.logFile)
    const child = this.spawn()
    this.child = child

    const exitedDuringStart = new Promise<never>((_, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => reject(new Error(`Claw exited during start (code ${code}, signal ${signal})`)))
    })
    child.once('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null
        this.onExit(code, signal)
      }
    })

    this.starting = true
    let version: string
    try {
      const ready = async () => {
        if (child.pid !== undefined) await writeFileAtomic(this.pidFile, JSON.stringify({ pid: child.pid, port: this.options.port }))
        return this.waitForHealth(child)
      }
      ;({ version } = await Promise.race([ready(), exitedDuringStart]))
    } finally {
      this.starting = false
    }
    this.armStableTimer()
    this.emit('started', { pid: child.pid ?? -1, version })
    if (!existing) await reconcile?.(version)
    return { version }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearTimers()
    const child = this.child
    if (!child || !this.running || child.pid === undefined) return
    const exited = Promise.withResolvers<void>()
    const onExit = () => exited.resolve()
    child.once('exit', onExit)
    try {
      await this.stopTree(child.pid, exited.promise)
      await rm(this.pidFile, { force: true })
    } finally {
      child.off('exit', onExit)
      child.unref()
    }
  }

  private spawn(): ChildProcess {
    const log = openSync(this.options.logFile, 'a')
    try {
      return (this.options.spawn ?? spawn)(
        process.execPath,
        [this.options.cliPath, 'serve', '--port', String(this.options.port), '--host', '127.0.0.1'],
        {
          env: { ...process.env, ...this.options.env, OPENCLAW_SERVER_TOKEN: this.options.client.token },
          stdio: ['ignore', log, log],
          windowsHide: true,
          detached: process.platform !== 'win32',
        },
      )
    } finally {
      closeSync(log)
    }
  }

  private get pidFile(): string {
    return `${this.options.logFile}.pid`
  }

  private async recoveryPid(): Promise<number | null> {
    const saved: unknown = await readFile(this.pidFile, 'utf8')
      .then(text => JSON.parse(text) as unknown)
      .catch(() => null)
    if (!saved || typeof saved !== 'object' || !('port' in saved) || saved.port !== this.options.port || !('pid' in saved)) return null
    const pid = saved.pid
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || !processExists(pid)) return null
    return (await this.options.client.verifyRecoveryToken().catch(() => false)) ? pid : null
  }

  private async stopRecovered(pid: number): Promise<void> {
    if (!processExists(pid)) return
    const polling = new AbortController()
    const exited = async () => {
      while (processExists(pid)) await sleep(50, undefined, { signal: polling.signal })
    }
    try {
      await this.stopTree(pid, exited())
    } finally {
      polling.abort()
    }
  }

  private async stopTree(pid: number, exited: Promise<void>): Promise<void> {
    const timeout = this.options.stopTimeoutMs ?? STOP_TIMEOUT_MS
    const grace = Math.floor(timeout / 2)
    const run = this.options.exec ?? defaultExec
    const attempt = (signal: 'SIGTERM' | 'SIGKILL', ms: number) =>
      settlesWithin(Promise.race([exited, killTree(pid, run, signal, ms).then(() => exited)]), ms)
    if (!(await attempt('SIGTERM', grace)) && !(await attempt('SIGKILL', timeout - grace))) {
      throw new Error(`Claw did not exit within ${timeout} ms (PID ${pid})`)
    }
  }

  private async waitForHealth(child: ChildProcess): Promise<{ version: string }> {
    const timeoutMs = this.options.healthTimeoutMs ?? 30_000
    const deadline = Date.now() + timeoutMs
    while (this.child === child && !this.stopping && Date.now() < deadline) {
      const health = await this.options.client.health(1000)
      if (health && this.child === child && !this.stopping) return health
      await sleep(250)
    }
    if (this.child === child && !this.stopping) await this.stop()
    throw new Error(`Claw did not answer /health within ${timeoutMs} ms`)
  }

  private armStableTimer(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.stableTimer = setTimeout(() => (this.consecutiveCrashes = 0), this.options.stableAfterMs ?? 10 * 60_000)
    this.stableTimer.unref()
  }

  private clearTimers(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.restartTimer = null
    this.stableTimer = null
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.stableTimer) clearTimeout(this.stableTimer)
    if (this.stopping || this.starting) return
    const delays = this.options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS
    const restartInMs = delays[Math.min(this.consecutiveCrashes, delays.length - 1)] ?? 60_000
    this.consecutiveCrashes++
    this.emit('crashed', { code, signal, restartInMs })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopping) return
      this.start().catch(error => {
        this.emit('restartFailed', error as Error)
        this.onExit(null, null)
      })
    }, restartInMs)
  }
}

function processExists(pid: number): boolean {
  try {
    return process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function killTree(pid: number, run: Exec, signal: 'SIGTERM' | 'SIGKILL', timeoutMs: number): Promise<void> {
  if (process.platform === 'win32') {
    await run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs }).catch(() => undefined)
    return
  }
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}
