import { readJson, writeFileAtomic } from './fs-util.js'

/** `~/.grip/config.json`. Read when Grip starts; restart Grip after editing it. */
export type GripConfig = {
  /** Tailscale logins the web app answers, exactly as `tailscale status` shows them, e.g. `you@github`. */
  allowedLogins: string[]
}

const DEFAULT_CONFIG: GripConfig = { allowedLogins: [] }

/** Load the config, writing an empty one on first run so there is a file to edit. */
export async function loadConfig(path: string): Promise<GripConfig> {
  const raw = await readJson<Partial<GripConfig>>(path)
  if (raw === null) {
    await writeFileAtomic(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`)
    return { ...DEFAULT_CONFIG }
  }
  const logins = raw.allowedLogins
  if (logins !== undefined && !(Array.isArray(logins) && logins.every(l => typeof l === 'string'))) {
    throw new Error(`${path}: allowedLogins must be a list of Tailscale logins`)
  }
  return { allowedLogins: (logins ?? []).map(l => l.trim()).filter(Boolean) }
}
