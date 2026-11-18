import type { UsageWindow } from '../../src/quota/usage.js'

export const QUOTA_WINDOWS = ['5h', 'week'] as const

export function pickQuotaWindows(windows: readonly UsageWindow[] = []) {
  return {
    '5h': windows.find(window => window.name === '5h'),
    week: windows.find(window => window.name === 'week'),
  }
}
