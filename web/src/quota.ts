import type { UsageWindow } from '../../src/quota/usage.js'

export const QUOTA_WINDOWS = ['5h', 'week'] as const

export function pickQuotaWindows(windows: readonly UsageWindow[] = []) {
  return {
    '5h': windows.find(window => window.name === '5h'),
    week: windows.find(window => window.name === 'week'),
  }
}

/** When a window resets, as short as the quota footer needs it: `45m`, `4h`, `6d`, or `now`. */
export function resetText(iso: string | null, now: number): string {
  if (!iso) return ''
  const minutes = Math.round((Date.parse(iso) - now) / 60000)
  if (Number.isNaN(minutes)) return ''
  if (minutes <= 0) return 'now'
  if (minutes < 120) return `${minutes}m`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 1440)}d`
}
