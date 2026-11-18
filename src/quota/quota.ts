import { EventEmitter } from 'node:events'

import { readJson, writeFileAtomic } from '../fs-util.js'
import type { QuotaReaders } from './readers.js'
import { TOOL_NAMES, TOOLS, verdict } from './usage.js'
import type { ProviderUsage, Tone, ToolId, UsageWindow } from './usage.js'

/** A provider's last good reading, kept beside its last failure. */
export type ProviderQuota = ProviderUsage & { checkedAt: string | null; error: string | null; busy: boolean }

export type QuotaSnapshot = { providers: ProviderQuota[]; verdict: { text: string; tone: Tone } }

type Saved = { providers?: Partial<Record<ToolId, { windows?: UsageWindow[]; checkedAt?: string | null; error?: string | null }>> }

/** Providers a refresh reads unless told otherwise: the ones that cost nothing to read. */
export const FREE_PROVIDERS: readonly ToolId[] = ['codex', 'agy']

/** Reads after worker turns come at most this often per provider. Asked-for refreshes always run. */
const AFTER_TURN_GAP_MS = 60_000

export type QuotaOptions = { path: string; readers: QuotaReaders; now?: () => number }

/** Every provider, the paid Claude probe included: what the timer reads. */
export const ALL_PROVIDERS: readonly ToolId[] = TOOLS

/**
 * Quota windows for every provider (§8 of the design). Readings refresh on a timer (every
 * provider, Claude's one-line probe included), after worker turns, and when asked. The last
 * readings are saved, so a restart shows them at once.
 */
export class Quota extends EventEmitter<{ change: [QuotaSnapshot] }> {
  private readonly state = new Map<ToolId, { windows: UsageWindow[]; checkedAt: string | null; error: string | null }>()
  private readonly inFlight = new Map<ToolId, Promise<void>>()
  private readonly lastAuto = new Map<ToolId, number>()
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | null = null

  private constructor(private readonly options: QuotaOptions) {
    super()
    this.now = options.now ?? Date.now
    for (const p of TOOLS) this.state.set(p, { windows: [], checkedAt: null, error: null })
  }

  static async open(options: QuotaOptions): Promise<Quota> {
    const quota = new Quota(options)
    const saved = await readJson<Saved>(options.path).catch(() => null)
    for (const p of TOOLS) {
      const s = saved?.providers?.[p]
      if (s)
        quota.state.set(p, { windows: Array.isArray(s.windows) ? s.windows : [], checkedAt: s.checkedAt ?? null, error: s.error ?? null })
    }
    return quota
  }

  /** Current windows. A window whose reset time has passed shows 0% used and stale until read again. */
  snapshot(): QuotaSnapshot {
    const now = this.now()
    const providers = TOOLS.map((provider): ProviderQuota => {
      const s = this.state.get(provider)!
      const windows = s.windows.map(w => (w.resetsAt && Date.parse(w.resetsAt) <= now ? { ...w, usedPercent: 0, stale: true } : w))
      return { provider, windows, checkedAt: s.checkedAt, error: s.error, busy: this.inFlight.has(provider) }
    })
    return { providers, verdict: verdict(providers, now) }
  }

  /** Read the given providers again (Codex and agy by default) and return the new snapshot. */
  async refresh(providers: readonly ToolId[] = FREE_PROVIDERS): Promise<QuotaSnapshot> {
    await Promise.all(providers.map(p => this.read(p)))
    return this.snapshot()
  }

  /**
   * After a worker turn ends, read that provider again in the background. Claude is skipped:
   * Claw keeps the turn's `rate_limit_event` to itself, and a probe would spend quota.
   */
  afterTurn(provider: ToolId): void {
    if (!FREE_PROVIDERS.includes(provider)) return
    const now = this.now()
    if (now - (this.lastAuto.get(provider) ?? -Infinity) < AFTER_TURN_GAP_MS) return
    this.lastAuto.set(provider, now)
    void this.read(provider)
  }

  /** Read every provider now and then every `ms`. 0 or less leaves the timer off. */
  startTimer(ms: number): void {
    this.stopTimer()
    if (ms <= 0) return
    void this.refresh(ALL_PROVIDERS)
    this.timer = setInterval(() => void this.refresh(ALL_PROVIDERS), ms)
    this.timer.unref()
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** A line for `delegate` when this provider is low or out. Information only, never a block. */
  noteFor(provider: ToolId): string | null {
    const mine = this.snapshot().providers.filter(p => p.provider === provider)
    const v = verdict(mine, this.now())
    return v.tone === 'warn' || v.tone === 'alert' ? v.text : null
  }

  private read(provider: ToolId): Promise<void> {
    const running = this.inFlight.get(provider)
    if (running) return running
    const work = (async () => {
      const prev = this.state.get(provider)!
      try {
        const usage = await this.options.readers[provider]()
        const checkedAt = new Date(this.now()).toISOString()
        this.state.set(
          provider,
          usage
            ? { windows: usage.windows, checkedAt, error: null }
            : { ...prev, checkedAt, error: `${TOOL_NAMES[provider]} reported no quota windows` },
        )
      } catch (error) {
        this.state.set(provider, { ...prev, error: (error as Error).message })
      }
    })().finally(async () => {
      this.inFlight.delete(provider)
      await this.save().catch(() => undefined)
      this.emit('change', this.snapshot())
    })
    this.inFlight.set(provider, work)
    this.emit('change', this.snapshot())
    return work
  }

  private async save(): Promise<void> {
    const providers = Object.fromEntries([...this.state.entries()])
    await writeFileAtomic(this.options.path, `${JSON.stringify({ providers }, null, 2)}\n`)
  }
}
