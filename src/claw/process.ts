import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

import { exec as defaultExec } from '../exec.js'
import type { Exec } from '../exec.js'
import type { ClawClient } from './client.js'

export type ClawProcessOptions = {
  client: ClawClient
  /** Resolved fresh on every start, since an update moves nothing but may change the file. */
  cliPath: () => Promise<string>
  port: number
  token: string
  logFile: string
  /** Extra environment for Claw and every engine it spawns. */
  env?: NodeJS.ProcessEnv
  healthTimeoutMs?: number
  /** Restart delays after a crash, in ms; the last one repeats. */
  backoffMs?: readonly number[]
  /** Healthy this long and the backoff starts over. */
  stableAfterMs?: number
  spawnImpl?: typeof spawn
  exec?: Exec
}

export type ClawProcessEvents = {
  started: [{ pid: number; version: string }]
  crashed: [{ code: number | null; signal: NodeJS.Signals | null; restartInMs: number }]
  restartFailed: [Error]
}

const LOG_ROTATE_BYTES = 5 * 1024 * 1024
const DEFAULT_BACKOFF = [1000, 2000, 5000, 10_000, 30_000, 60_000]

/**
 * One `clawo serve` on loopback, owned by Grip. It restarts Claw after a crash with backoff,
 * and stops it with its whole process tree, engines included.
 */
export class ClawProcess extends EventEmitter<ClawProcessEvents> {
  private child: ChildProcess | null = null
  private stopping = false
  private starting = false
  private crashes = 0
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

  /** Start Claw and resolve once `/health` answers. Rejects if it exits or never answers. */
  async start(): Promise<{ version: string }> {
    if (this.running) throw new Error('Claw is already running under Grip')
    // Someone else on the port would answer our health checks with their own state.
    if (await this.options.client.health(1000)) {
      throw new Error(`port ${this.options.port} already answers as Claw; stop that server first`)
    }
    this.stopping = false
    const cli = await this.options.cliPath()
    const log = await openLog(this.options.logFile)
    const spawnImpl = this.options.spawnImpl ?? spawn
    const child = spawnImpl(process.execPath, [cli, 'serve', '--port', String(this.options.port), '--host', '127.0.0.1'], {
      env: { ...process.env, ...this.options.env, OPENCLAW_SERVER_TOKEN: this.options.token },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Its own process group on POSIX, so a stop takes the engines with it.
      detached: process.platform !== 'win32',
    })
    this.child = child
    child.stdout?.pipe(log, { end: false })
    child.stderr?.pipe(log, { end: false })

    const exited = new Promise<never>((_, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => reject(new Error(`Claw exited during start (code ${code}, signal ${signal})`)))
    })
    child.once('exit', (code, signal) => {
      log.end()
      if (this.child === child) this.child = null
      this.onExit(code, signal)
    })

    this.starting = true
    let health: { version: string }
    try {
      health = await Promise.race([this.waitForHealth(), exited])
    } finally {
      this.starting = false
    }
    this.armStableTimer()
    this.emit('started', { pid: child.pid ?? -1, version: health.version })
    return { version: health.version }
  }

  private async waitForHealth(): Promise<{ version: string }> {
    const deadline = Date.now() + (this.options.healthTimeoutMs ?? 30_000)
    while (Date.now() < deadline) {
      const health = await this.options.client.health(1000)
      if (health) return health
      await sleep(250)
    }
    await this.stop()
    throw new Error(`Claw did not answer /health within ${this.options.healthTimeoutMs ?? 30_000} ms`)
  }

  private armStableTimer(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.stableTimer = setTimeout(() => (this.crashes = 0), this.options.stableAfterMs ?? 10 * 60 * 1000)
    this.stableTimer.unref()
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.stableTimer) clearTimeout(this.stableTimer)
    // A failed start is reported by start() itself; restarting is its caller's call.
    if (this.stopping || this.starting) return
    const backoff = this.options.backoffMs ?? DEFAULT_BACKOFF
    const restartInMs = backoff[Math.min(this.crashes, backoff.length - 1)] ?? 60_000
    this.crashes++
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

  /** Stop Claw and every process it started. Resolves once it has exited. */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.restartTimer = null
    const child = this.child
    if (!child || !this.running || child.pid === undefined) return
    const gone = new Promise<void>(resolve => child.once('exit', () => resolve()))
    await killTree(child.pid, this.options.exec ?? defaultExec)
    const forced = setTimeout(() => killTree(child.pid!, this.options.exec ?? defaultExec, true), 5000)
    await gone
    clearTimeout(forced)
  }
}

/** Windows has no process groups to signal, so `taskkill /T` walks the tree instead. */
async function killTree(pid: number, run: Exec, force = false): Promise<void> {
  if (process.platform === 'win32') {
    await run('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => undefined)
    return
  }
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch {
    // Already gone.
  }
}

async function openLog(path: string) {
  await mkdir(dirname(path), { recursive: true })
  try {
    if ((await stat(path)).size > LOG_ROTATE_BYTES) await rename(path, `${path}.1`)
  } catch {
    // No log yet.
  }
  return createWriteStream(path, { flags: 'a' })
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
