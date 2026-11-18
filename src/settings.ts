/**
 * Grip's tunable timings, all in one place. Each can be changed in `~/.grip/config.json` under
 * `settings` (restart Grip after editing). Timeouts for single CLI calls stay beside the code that
 * makes them; they are safety limits, not choices.
 */
export type Settings = {
  /** Read every agent's quota this often, Claude's probe included. 0 turns the timer off. */
  quotaRefreshMinutes: number
  /** Read each agent's model list again after this long. */
  modelListRefreshMinutes: number
  /** Look for a newer Claw this often. */
  clawUpdateCheckHours: number
  /** Give up on one chat or worker turn after this long. Long by default: real work can take days, and Stop ends a turn sooner. */
  turnTimeoutMinutes: number
  /** Forget an MCP session (a Claude Code chat) idle this long. It then reconnects as a new chat. */
  mcpSessionIdleDays: number
  /** How long a push service keeps trying to deliver a notification to a device that is off or out of signal. */
  pushExpiryHours: number
}

export const DEFAULT_SETTINGS: Settings = {
  quotaRefreshMinutes: 5,
  modelListRefreshMinutes: 60,
  clawUpdateCheckHours: 24,
  turnTimeoutMinutes: 3 * 24 * 60,
  mcpSessionIdleDays: 7,
  pushExpiryHours: 24,
}

/** Defaults with the config file's values over them. Unknown keys and bad values are refused. */
export function readSettings(raw: unknown, source: string): Settings {
  if (raw === undefined || raw === null) return { ...DEFAULT_SETTINGS }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${source}: settings must be an object`)
  const out = { ...DEFAULT_SETTINGS }
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in DEFAULT_SETTINGS)) throw new Error(`${source}: unknown setting ${key}; known: ${Object.keys(DEFAULT_SETTINGS).join(', ')}`)
    const min = key === 'quotaRefreshMinutes' ? 0 : Number.MIN_VALUE
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min)
      throw new Error(`${source}: settings.${key} must be a number above 0${min === 0 ? ', or 0 for off' : ''}`)
    out[key as keyof Settings] = value
  }
  return out
}

export const minutes = (n: number) => n * 60_000
export const hours = (n: number) => n * 60 * 60_000
export const days = (n: number) => n * 24 * 60 * 60_000
