// Quota parsers, ported from alethe-orchestrate's `orchestrate.py` (`quota_window`, `claude_quota`,
// `agy_quota`, `codex_quota`; MIT). Codex is read from the app-server's `account/rateLimits/read`
// answer instead of rollout files. Malformed or unknown windows are skipped, never fatal.

import type { ProviderUsage, ToolId, UsageWindow } from './usage.js'

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

/** Unix seconds or an ISO string, as an ISO string. */
function timestamp(value: unknown): string | null {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(ms)) return null
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** A window, or null unless the percentage is within 0 to 100 and the reset time is readable. */
function window(name: string, percent: number | null, reset: unknown, observedAt: string): UsageWindow | null {
  const resetsAt = timestamp(reset)
  if (percent === null || percent < 0 || percent > 100 || resetsAt === null) return null
  return { name, usedPercent: Math.round(percent * 10000) / 10000, resetsAt, stale: false, observedAt }
}

const usage = (provider: ToolId, windows: UsageWindow[]): ProviderUsage | null => (windows.length ? { provider, windows } : null)

/** Every JSON value in a command's output: one document, an array of them, or one per line. */
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

/**
 * Codex's `account/rateLimits/read` result, or the `rateLimits` snapshot inside a
 * `account/rateLimits/updated` notification. Reads the `codex` limit; `primary` and `secondary`
 * are named by their length (300 minutes is 5h, 10080 is the week). `resetsAt` is in Unix seconds.
 */
export function parseCodexRateLimits(result: unknown, observedAt: string): ProviderUsage | null {
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

/** `agy -p /usage --output-format json`: buckets carry the fraction left, not the fraction used. */
export function parseAgyUsage(stdout: string, observedAt: string): ProviderUsage | null {
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

/**
 * The last `rate_limit_event` in Claude stream-json output. `utilization` is a fraction, and
 * `resetsAt` is in Unix seconds.
 */
export function parseClaudeRateLimit(stdout: string, observedAt: string): ProviderUsage | null {
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
