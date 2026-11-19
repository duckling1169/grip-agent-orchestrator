// Quota parsers, ported from alethe-orchestrate's `orchestrate.py` (`quota_window`, `claude_quota`,
// `agy_quota`, `codex_quota`; MIT). Codex is read from the app-server's `account/rateLimits/read`
// answer instead of rollout files. Malformed or unknown windows are skipped, never fatal.

import type { EngineUsage, UsageWindow } from '../contracts/api.js'
import type { QuotaEngine } from './quota-readers.js'

const CLAUDE_WINDOWS: Record<string, string> = { five_hour: '5h', seven_day: 'week', seven_day_opus: 'opus', opus: 'opus' }
const CODEX_WINDOWS: Record<number, string> = { 300: '5h', 10080: 'week' }
const AGY_WINDOWS: Record<string, string> = {
  'gemini-5h': '5h',
  'gemini-weekly': 'week',
  'gemini-argon-wtu-weekly': 'argon',
  '3p-5h': '3p-5h',
  '3p-weekly': '3p-week',
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function timestamp(value: unknown): string | null {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(ms)) return null
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function window(name: string, percent: number | null, reset: unknown, observedAt: string): UsageWindow | null {
  const resetsAt = timestamp(reset)
  if (percent === null || percent < 0 || percent > 100 || resetsAt === null) return null
  return { name, usedPercent: Math.round(percent * 10000) / 10000, resetsAt, stale: false, observedAt }
}

const usage = (engine: QuotaEngine, windows: UsageWindow[]): EngineUsage | null => (windows.length ? { engine, windows } : null)

export function jsonValues(text: string): unknown[] {
  try {
    const whole = JSON.parse(text) as unknown
    return Array.isArray(whole) ? whole : [whole]
  } catch {
    return text.split(/\r?\n/).flatMap(line => {
      try {
        return line.trim() ? [JSON.parse(line) as unknown] : []
      } catch {
        return []
      }
    })
  }
}

export function parseCodexRateLimits(result: unknown, observedAt: string): EngineUsage | null {
  if (!isObj(result)) return null
  const byId = isObj(result.rateLimitsByLimitId) ? result.rateLimitsByLimitId.codex : undefined
  const snapshot = isObj(byId) ? byId : isObj(result.rateLimits) ? result.rateLimits : isObj(result.primary) ? result : null
  if (!snapshot || (snapshot.limitId != null && snapshot.limitId !== 'codex')) return null
  const windows: UsageWindow[] = []
  for (const key of ['primary', 'secondary'] as const) {
    const raw = snapshot[key]
    if (!isObj(raw)) continue
    const name = CODEX_WINDOWS[num(raw.windowDurationMins) ?? -1]
    const w = name ? window(name, num(raw.usedPercent), raw.resetsAt, observedAt) : null
    if (w) windows.push(w)
  }
  return usage('codex', windows)
}

export function parseAgyUsage(stdout: string, observedAt: string): EngineUsage | null {
  const event = jsonValues(stdout)
    .reverse()
    .find((v): v is Obj => isObj(v) && v.status === 'SUCCESS' && isObj(v.command))
  const data = event && (event.command as Obj).data
  if (!isObj(data) || !Array.isArray(data.groups)) return null
  const windows: UsageWindow[] = []
  for (const group of data.groups) {
    if (!isObj(group) || !Array.isArray(group.buckets)) continue
    for (const bucket of group.buckets) {
      if (!isObj(bucket)) continue
      const name = typeof bucket.id === 'string' ? AGY_WINDOWS[bucket.id] : undefined
      const remaining = num(bucket.remaining_fraction)
      const w = name && remaining !== null ? window(name, (1 - remaining) * 100, bucket.reset_time, observedAt) : null
      if (w) windows.push(w)
    }
  }
  return usage('agy', windows)
}

export function parseClaudeRateLimit(stdout: string, observedAt: string): EngineUsage | null {
  const event = jsonValues(stdout)
    .reverse()
    .find((v): v is Obj => isObj(v) && v.type === 'rate_limit_event')
  const info = event?.rate_limit_info
  if (!isObj(info) || !isObj(info.unifiedWindows)) return null
  const windows = new Map<string, UsageWindow>()
  for (const [key, name] of Object.entries(CLAUDE_WINDOWS)) {
    const raw = info.unifiedWindows[key]
    if (!isObj(raw) || windows.has(name)) continue
    const fraction = num(raw.utilization)
    const w = window(name, fraction === null ? null : fraction * 100, raw.resetsAt, observedAt)
    if (w) windows.set(name, w)
  }
  return usage('claude', [...windows.values()])
}
