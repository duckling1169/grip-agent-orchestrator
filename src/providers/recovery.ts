import type { EngineQuota, Recovery, UsageWindow } from '../contracts/api.js'
import { engineSpec, LEADER_ENGINES } from '../contracts/engines.js'
import type { Engine } from '../contracts/engines.js'

const QUOTA_FAILURE =
  /\b(?:429|too many requests|rate[\s_-]*limit(?:ed|[\s_-]*(?:exceeded|reached|error))?|usage[\s_-]*limit(?:[\s_-]*(?:exceeded|reached))?|hit your limit|insufficient[\s_-]*quota|resource[\s_-]*exhausted|quota[\s_-]*(?:exhausted|exceeded|reached)|exceeded(?:\s+\w+){0,3}\s+quota)\b/i

export function recoveryFor(
  engine: Engine,
  error: string | null,
  quota: readonly EngineQuota[],
  available: (engine: Engine) => boolean,
): Recovery | null {
  const now = Date.now()
  const windows = providerWindows(engine, quota)
  const exhausted = windows.filter(window => spent(window, now))
  if (!exhausted.length && (!error || !QUOTA_FAILURE.test(error))) return null
  const candidates = LEADER_ENGINES.filter(candidate => candidate !== engine && available(candidate)).filter(
    candidate => !providerWindows(candidate, quota).some(window => spent(window, now)),
  )
  const knownAvailable = candidates.find(candidate => {
    const windows = providerWindows(candidate, quota)
    return windows.length > 0 && windows.every(window => fresh(window, now) && window.usedPercent < 100)
  })
  const fallback = knownAvailable ?? candidates[0]
  const resetsAt =
    exhausted.length && exhausted.every(window => window.resetsAt !== null)
      ? exhausted.map(window => window.resetsAt!).sort((a, b) => Date.parse(b) - Date.parse(a))[0]!
      : null
  return {
    provider: engine,
    resetsAt,
    suggested: fallback ? { engine: fallback, model: null, effort: null } : null,
    reason: error ?? `${engineSpec(engine).name} has no remaining quota in its current provider window`,
  }
}

function providerWindows(engine: Engine, quota: readonly EngineQuota[]): UsageWindow[] {
  const reading = quota.find(reading => reading.engine === engine)
  return reading && !reading.error ? reading.windows.filter(window => window.name === '5h' || window.name === 'week') : []
}

function spent(window: UsageWindow, now: number): boolean {
  return fresh(window, now) && window.usedPercent >= 100
}

function fresh(window: UsageWindow, now: number): boolean {
  return (
    !window.stale &&
    Number.isFinite(window.usedPercent) &&
    window.usedPercent >= 0 &&
    window.usedPercent <= 100 &&
    (window.resetsAt === null || Date.parse(window.resetsAt) > now)
  )
}
