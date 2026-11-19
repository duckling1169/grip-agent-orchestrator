import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createWriteStream } from 'node:fs'

import { exec as defaultExec } from '../../exec.js'
import type { Exec } from '../../exec.js'
import { rotateIfLarge } from '../../log.js'
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
}

export type ClawProcessEvents = {
  started: [{ pid: number; version: string }]
  crashed: [{ code: number | null; signal: NodeJS.Signals | null; restartInMs: number }]
  restartFailed: [Error]
}

const DEFAULT_RESTART_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000, 60_000]
const FORCE_KILL_AFTER_MS = 5000

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

  async start(): Promise<{ version: string }> {
    if (this.running) throw new Error('Claw is already running')
    if (await this.options.client.health(1000)) {
      throw new Error(`port ${this.options.port} already answers as Claw; stop that server first`)
    }
    this.stopping = false
    rotateIfLarge(this.options.logFile)
    const log = createWriteStream(this.options.logFile, { flags: 'a' })
    const child = spawn(process.execPath, [this.options.cliPath, 'serve', '--port', String(this.options.port), '--host', '127.0.0.1'], {
      env: { ...process.env, ...this.options.env, OPENCLAW_SERVER_TOKEN: this.options.client.token },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    this.child = child
    child.stdout?.pipe(log, { end: false })
    child.stderr?.pipe(log, { end: false })

    const exitedDuringStart = new Promise<never>((_, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => reject(new Error(`Claw exited during start (code ${code}, signal ${signal})`)))
    })
    child.once('exit', (code, signal) => {
      log.end()
      if (this.child === child) this.child = null
      this.onExit(code, signal)
    })

    this.starting = true
    let version: string
    try {
      ;({ version } = await Promise.race([this.waitForHealth(), exitedDuringStart]))
    } finally {
      this.starting = false
    }
    this.armStableTimer()
    this.emit('started', { pid: child.pid ?? -1, version })
    return { version }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearTimers()
    const child = this.child
    if (!child || !this.running || child.pid === undefined) return
    const pid = child.pid
    const run = this.options.exec ?? defaultExec
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    await killTree(pid, run, 'SIGTERM')
    const forceKill = setTimeout(() => void killTree(pid, run, 'SIGKILL'), FORCE_KILL_AFTER_MS)
    await exited
    clearTimeout(forceKill)
  }

  private async waitForHealth(): Promise<{ version: string }> {
    const timeoutMs = this.options.healthTimeoutMs ?? 30_000
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const health = await this.options.client.health(1000)
      if (health) return health
      await sleep(250)
    }
    await this.stop()
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

async function killTree(pid: number, run: Exec, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  if (process.platform === 'win32') {
    await run('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => undefined)
    return
  }
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
