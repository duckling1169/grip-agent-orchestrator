import { EventEmitter } from 'node:events'

import semver from 'semver'

import { gateSummary } from './gate.js'
import type { GateResult } from './gate.js'
import type { ClawPackages } from './packages.js'
import type { ClawHistoryEntry, ClawState, ClawStateStore } from './state.js'
import { CLAW_RANGE, inRange, isNewer, pendingMajor, pickTarget } from './versions.js'

/** The part of `ClawProcess` the supervisor drives; a fake stands in for it in tests. */
export interface ClawRunner {
  start(): Promise<{ version: string }>
  stop(): Promise<void>
  readonly running: boolean
}

export type SupervisorStatus = 'stopped' | 'starting' | 'ready' | 'updating' | 'degraded'

export type UpdateOutcome =
  | { kind: 'up-to-date'; version: string }
  | { kind: 'deferred'; reason: 'busy' | 'offline'; target?: string }
  | { kind: 'updated'; from: string; to: string }
  | { kind: 'rolled-back'; attempted: string; to: string; reason: string }
  | { kind: 'failed'; reason: string }

export type SupervisorEvents = {
  status: [SupervisorStatus]
  'rolled-back': [{ attempted: string; to: string; reason: string }]
  'major-available': [string]
  error: [Error]
}

export type SupervisorOptions = {
  packages: ClawPackages
  runner: ClawRunner
  gate: (expectedVersion: string) => Promise<GateResult>
  store: ClawStateStore
  /** True when no worker is running, so Claw can be restarted without cutting one off. */
  isIdle: () => Promise<boolean>
  range?: string
  checkEveryMs?: number
  /** How soon to try again when an update had to wait for running workers. */
  retryBusyMs?: number
  now?: () => Date
}

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/**
 * Keeps one Claw installed within the allowed range, running, and on the newest release that
 * passes the health gate. An update happens only while idle; one that fails the gate is rolled
 * back to the last good version and not tried again until a newer release appears.
 */
export class ClawSupervisor extends EventEmitter<SupervisorEvents> {
  private _status: SupervisorStatus = 'stopped'
  private _version: string | null = null
  private _history: ClawHistoryEntry[] = []
  private timer: NodeJS.Timeout | null = null
  private busy: Promise<unknown> | null = null
  private readonly range: string

  constructor(private readonly options: SupervisorOptions) {
    super()
    this.range = options.range ?? CLAW_RANGE
  }

  get status(): SupervisorStatus {
    return this._status
  }

  /** The Claw version running now, or null. */
  get version(): string | null {
    return this._version
  }

  /** Recent persisted update events, loaded at startup and refreshed when an event is recorded. */
  get history(): readonly ClawHistoryEntry[] {
    return structuredClone(this._history)
  }

  /**
   * Resolves once Claw can take work: ready, or up but degraded. A turn that arrives during a
   * start or an update waits here instead of failing; it gives up after `timeoutMs`.
   */
  whenReady(timeoutMs = 5 * 60 * 1000): Promise<void> {
    const usable = (s: SupervisorStatus) => s === 'ready' || s === 'degraded'
    if (usable(this._status)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('status', onStatus)
        reject(new Error(`Claw is not ready (${this._status})`))
      }, timeoutMs)
      const onStatus = (s: SupervisorStatus) => {
        if (!usable(s)) return
        clearTimeout(timer)
        this.off('status', onStatus)
        resolve()
      }
      this.on('status', onStatus)
    })
  }

  private setStatus(status: SupervisorStatus): void {
    if (status === this._status) return
    this._status = status
    this.emit('status', status)
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString()
  }

  /** One install, update or restart at a time; a second caller waits for the first. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = (this.busy ?? Promise.resolve()).catch(() => undefined).then(work)
    this.busy = run.finally(() => {
      if (this.busy === guarded) this.busy = null
    })
    const guarded = this.busy
    return run
  }

  /** Install Claw if needed, start it, gate it, and schedule update checks. */
  async start(): Promise<void> {
    await this.exclusive(() => this.boot())
    this.schedule(this.options.checkEveryMs ?? DAY_MS)
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.exclusive(async () => {
      await this.options.runner.stop()
      this._version = null
      this.setStatus('stopped')
    })
  }

  /**
   * Stop Claw with every engine process it started, then start the same version again. Stop all
   * uses this when Claw does not stop its sessions in time. The version already passed its gate.
   */
  async restart(): Promise<void> {
    await this.exclusive(async () => {
      const before = this._status
      this.setStatus('starting')
      await this.options.runner.stop()
      await this.options.runner.start()
      this.setStatus(before === 'degraded' ? 'degraded' : 'ready')
    })
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.checkForUpdate()
        .then(outcome =>
          this.schedule(outcome.kind === 'deferred' ? (this.options.retryBusyMs ?? HOUR_MS) : (this.options.checkEveryMs ?? DAY_MS)),
        )
        .catch(error => {
          this.emit('error', error as Error)
          this.schedule(this.options.checkEveryMs ?? DAY_MS)
        })
    }, ms)
    this.timer.unref()
  }

  private async boot(): Promise<void> {
    this.setStatus('starting')
    const state = await this.options.store.load()
    this._history = structuredClone(state.history)
    let installed = await this.options.packages.installed()

    if (!inRange(installed, this.range)) {
      // Prefer the version that last passed; otherwise the newest in range.
      const target = inRange(state.lastGood, this.range) ? state.lastGood : pickTarget(await this.options.packages.available(), this.range)
      if (!target) throw new Error(`no Claw release satisfies ${this.range}`)
      await this.options.packages.install(target)
      this.log(state, { kind: 'installed', from: installed, to: target })
      installed = target
    }

    await this.options.runner.start()
    this._version = installed
    const gate = await this.options.gate(installed)
    if (gate.ok) {
      state.lastGood = installed
      await this.options.store.save(state)
      this.setStatus('ready')
      return
    }

    if (state.lastGood && state.lastGood !== installed && inRange(state.lastGood, this.range)) {
      await this.rollback(state, installed, state.lastGood, gateSummary(gate))
      return
    }
    // Nothing better to fall back to: keep Claw up and say it is not trusted.
    this.log(state, { kind: 'gate-failed', from: installed, to: installed, detail: gateSummary(gate) })
    await this.options.store.save(state)
    this.setStatus('degraded')
  }

  /** Look for a newer release in range and move to it if Grip is idle and it passes the gate. */
  checkForUpdate(): Promise<UpdateOutcome> {
    return this.exclusive(() => this.update())
  }

  private async update(): Promise<UpdateOutcome> {
    const state = await this.options.store.load()
    this._history = structuredClone(state.history)
    let available: string[]
    try {
      available = await this.options.packages.available()
    } catch {
      return { kind: 'deferred', reason: 'offline' }
    }
    state.lastCheckAt = this.now()

    const major = pendingMajor(available, this.range)
    if (major && major !== state.pendingMajor) this.emit('major-available', major)
    state.pendingMajor = major

    const current = this._version ?? (await this.options.packages.installed())
    const target = pickTarget(available, this.range)
    const fresh =
      target && isNewer(target, current) && !(state.rejected && semver.valid(state.rejected) && !semver.gt(target, state.rejected))
    if (!target || !fresh) {
      await this.options.store.save(state)
      return { kind: 'up-to-date', version: current ?? 'none' }
    }
    if (!(await this.options.isIdle())) {
      await this.options.store.save(state)
      return { kind: 'deferred', reason: 'busy', target }
    }

    this.setStatus('updating')
    const from = current
    try {
      await this.options.runner.stop()
      await this.options.packages.install(target)
      await this.options.runner.start()
      this._version = target
    } catch (error) {
      const reason = (error as Error).message
      if (from) return this.rollback(state, target, from, reason)
      this.setStatus('degraded')
      return { kind: 'failed', reason }
    }

    const gate = await this.options.gate(target)
    if (!gate.ok) return this.rollback(state, target, state.lastGood ?? from ?? target, gateSummary(gate))

    state.lastGood = target
    this.log(state, { kind: 'updated', from, to: target })
    await this.options.store.save(state)
    this.setStatus('ready')
    return { kind: 'updated', from: from ?? 'none', to: target }
  }

  private async rollback(state: ClawState, attempted: string, to: string, reason: string): Promise<UpdateOutcome> {
    state.rejected = attempted
    try {
      if (this.options.runner.running) await this.options.runner.stop()
      if ((await this.options.packages.installed()) !== to) await this.options.packages.install(to)
      await this.options.runner.start()
      this._version = to
    } catch (error) {
      this.log(state, { kind: 'rolled-back', from: attempted, to, detail: `${reason}; rollback failed: ${(error as Error).message}` })
      await this.options.store.save(state)
      this.setStatus('degraded')
      return { kind: 'failed', reason: `rollback to ${to} failed: ${(error as Error).message}` }
    }
    this.log(state, { kind: 'rolled-back', from: attempted, to, detail: reason })
    await this.options.store.save(state)
    this.setStatus('ready')
    this.emit('rolled-back', { attempted, to, reason })
    return { kind: 'rolled-back', attempted, to, reason }
  }

  private log(state: ClawState, entry: Omit<ClawHistoryEntry, 'at'>): void {
    state.history.push({ at: this.now(), ...entry })
    this._history = structuredClone(state.history)
  }
}
