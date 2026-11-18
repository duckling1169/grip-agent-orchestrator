// Copied from duckling1169/agent-usage (`types/index.d.ts` and `hooks/lib/logic.ts`), so Grip's
// quota strip and notes use the same shapes and wording. The two copies change independently.
// Added here: the `opus` window label.

/** A provider Grip reads quota for. The same names as Grip's engines. */
export type ToolId = 'codex' | 'agy' | 'claude'

/** One quota window. */
export type UsageWindow = { name: string; usedPercent: number; resetsAt: string | null; stale: boolean; observedAt: string | null }
export type ProviderUsage = { provider: ToolId; windows: UsageWindow[] }

export const TOOLS: readonly ToolId[] = ['codex', 'agy', 'claude']
export const TOOL_NAMES: Record<ToolId, string> = { codex: 'Codex', agy: 'Antigravity', claude: 'Claude' }

export type Tone = 'normal' | 'quiet' | 'warn' | 'alert' | 'brand'

/** One line on the tightest fresh window. */
export function verdict(providers: ProviderUsage[], now: number): { text: string; tone: Tone } {
  let worst: { provider: ToolId; left: number; resetsAt: string | null } | null = null
  for (const p of providers)
    for (const w of p.windows) {
      if (w.stale) continue
      const left = 100 - w.usedPercent
      if (!worst || left < worst.left) worst = { provider: p.provider, left, resetsAt: w.resetsAt }
    }
  if (!worst) return { text: 'Waiting for a reading', tone: 'quiet' }
  const name = TOOL_NAMES[worst.provider]
  if (worst.left <= 5) return { text: `${name} is out, back ${untilText(worst.resetsAt, now)}`, tone: 'alert' }
  if (worst.left <= 20) return { text: `${name} is running low (${Math.round(worst.left)}% left)`, tone: 'warn' }
  return { text: 'Plenty of room everywhere', tone: 'quiet' }
}

export function windowLevel(left: number): Tone {
  return left <= 5 ? 'alert' : left <= 20 ? 'warn' : 'normal'
}

export function minutesBetween(fromIso: string | null, now: number): number | null {
  if (!fromIso) return null
  const t = Date.parse(fromIso)
  return Number.isNaN(t) ? null : Math.max(0, Math.round((now - t) / 60000))
}

export function agoText(iso: string | null, now: number): string {
  const m = minutesBetween(iso, now)
  if (m === null) return 'unknown'
  return m < 1 ? 'just now' : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`
}

export function untilText(iso: string | null, now: number): string {
  if (!iso) return ''
  const m = Math.round((Date.parse(iso) - now) / 60000)
  if (m <= 0) return 'reset due'
  if (m < 120) return `in ${m} min`
  if (m < 48 * 60) return `in ${Math.round(m / 60)} h`
  return `in ${Math.round(m / 1440)} d`
}

export function durationText(minutes: number): string {
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

export const WINDOW_LABELS: Record<string, { long: string; short: string }> = {
  '5h': { long: '5 hours', short: '5h' },
  week: { long: 'Week', short: 'Week' },
  opus: { long: 'Opus week', short: 'Opus' },
  '3p-5h': { long: 'Claude/GPT 5 hours', short: 'C/G 5h' },
  '3p-week': { long: 'Claude/GPT week', short: 'C/G wk' },
  argon: { long: 'Argon week', short: 'Argon' },
}
