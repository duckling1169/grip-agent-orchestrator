import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'

import type { EngineQuota, UsageWindow } from '../contracts/api.js'
import { engineSpec } from '../contracts/engines.js'
import { errorText } from '../errors.js'
import { writeFileAtomic } from '../files.js'
import { QUOTA_ENGINES } from './quota-readers.js'
import type { QuotaEngine, QuotaReaders } from './quota-readers.js'

type Reading = { windows: UsageWindow[]; checkedAt: string | null; error: string | null }
type Saved = { engines?: Partial<Record<QuotaEngine, Reading>> }
export type QuotaOptions = { path: string; readers: QuotaReaders; now?: () => number }

export const FREE_QUOTA_ENGINES: readonly QuotaEngine[] = ['codex', 'agy']

export class Quota extends EventEmitter<{ change: [EngineQuota[]] }> {
  private readonly state = new Map<QuotaEngine, Reading>()
  private readonly inFlight = new Map<QuotaEngine, Promise<void>>()
  private readonly lastAuto = new Map<QuotaEngine, number>()
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | null = null
  private saving: Promise<void> = Promise.resolve()
  private closed = false

  private constructor(private readonly options: QuotaOptions) {
    super()
    this.now = options.now ?? Date.now
    for (const engine of QUOTA_ENGINES) this.state.set(engine, { windows: [], checkedAt: null, error: null })
  }

  static async open(options: QuotaOptions): Promise<Quota> {
    const quota = new Quota(options)
    const saved: Saved | null = await readFile(options.path, 'utf8')
      .then(text => JSON.parse(text) as Saved)
      .catch(() => null)
    for (const engine of QUOTA_ENGINES) {
      const reading = saved?.engines?.[engine]
      if (!reading || !Array.isArray(reading.windows)) continue
      quota.state.set(engine, {
        windows: reading.windows.filter(validWindow),
        checkedAt: typeof reading.checkedAt === 'string' ? reading.checkedAt : null,
        error: typeof reading.error === 'string' ? reading.error : null,
      })
    }
    return quota
  }

  snapshot(): EngineQuota[] {
    const now = this.now()
    return QUOTA_ENGINES.map(engine => {
      const reading = this.state.get(engine)!
      return {
        engine,
        windows: reading.windows.map(window => ({
          ...window,
          stale: window.stale || reading.error !== null || (window.resetsAt !== null && Date.parse(window.resetsAt) <= now),
        })),
        checkedAt: reading.checkedAt,
        error: reading.error,
        busy: this.inFlight.has(engine),
      }
    })
  }

  async refresh(engines: readonly QuotaEngine[] = FREE_QUOTA_ENGINES): Promise<EngineQuota[]> {
    if (!this.closed) await Promise.all(engines.map(engine => this.read(engine)))
    return this.snapshot()
  }

  afterTurn(engine: string): void {
    const provider = FREE_QUOTA_ENGINES.find(candidate => candidate === engine)
    if (!provider || this.closed) return
    const now = this.now()
    if (now - (this.lastAuto.get(provider) ?? -Infinity) < 60_000) return
    this.lastAuto.set(provider, now)
    void this.read(provider)
  }

  startTimer(ms: number): void {
    this.stopTimer()
    if (ms <= 0 || this.closed) return
    this.timer = setInterval(() => void this.refresh(QUOTA_ENGINES), ms)
    this.timer.unref()
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async idle(): Promise<void> {
    await Promise.all(this.inFlight.values())
    await this.saving
  }

  async close(): Promise<void> {
    this.closed = true
    this.stopTimer()
    await this.idle()
  }

  private read(engine: QuotaEngine): Promise<void> {
    const running = this.inFlight.get(engine)
    if (running) return running
    const work = Promise.resolve()
      .then(async () => {
        const previous = this.state.get(engine)!
        try {
          const usage = await this.options.readers[engine]()
          const checkedAt = new Date(this.now()).toISOString()
          this.state.set(
            engine,
            usage
              ? { windows: usage.windows, checkedAt, error: null }
              : { ...previous, checkedAt, error: `${engineSpec(engine).name} reported no quota windows` },
          )
        } catch (error) {
          this.state.set(engine, { ...previous, checkedAt: new Date(this.now()).toISOString(), error: errorText(error) })
        }
      })
      .finally(async () => {
        this.inFlight.delete(engine)
        const data = `${JSON.stringify({ engines: Object.fromEntries(this.state) }, null, 2)}\n`
        this.saving = this.saving.then(() => writeFileAtomic(this.options.path, data)).catch(() => undefined)
        await this.saving
        this.emit('change', this.snapshot())
      })
    this.inFlight.set(engine, work)
    this.emit('change', this.snapshot())
    return work
  }
}

function validWindow(value: unknown): value is UsageWindow {
  if (typeof value !== 'object' || value === null) return false
  const window = value as Partial<UsageWindow>
  return (
    typeof window.name === 'string' &&
    typeof window.usedPercent === 'number' &&
    Number.isFinite(window.usedPercent) &&
    window.usedPercent >= 0 &&
    window.usedPercent <= 100 &&
    (window.resetsAt === null || (typeof window.resetsAt === 'string' && Number.isFinite(Date.parse(window.resetsAt)))) &&
    (window.observedAt === null || (typeof window.observedAt === 'string' && Number.isFinite(Date.parse(window.observedAt)))) &&
    typeof window.stale === 'boolean'
  )
}
