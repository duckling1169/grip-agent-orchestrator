import { readJson, writeFileAtomic } from './fs-util.js'

/** `~/.grip/config.json`. Read when Grip starts; restart Grip after editing it. */
export type GripConfig = {
  /** Tailscale logins the web app answers, exactly as `tailscale status` shows them, e.g. `you@github`. */
  allowedLogins: string[]
}

export type LoadConfigOptions = {
  /** The Tailscale login this machine is signed in to, trusted when no login is listed yet. */
  owner?: () => Promise<string | null>
}

/**
 * Load the config. While no login is listed, Grip trusts the Tailscale account this machine is
 * signed in to and writes it into the file, so nothing needs editing by hand. Edit the list
 * afterwards to allow other logins.
 */
export async function loadConfig(path: string, options: LoadConfigOptions = {}): Promise<GripConfig & { trustedOwner: string | null }> {
  const raw = await readJson<Partial<GripConfig>>(path)
  const logins = raw?.allowedLogins
  if (logins !== undefined && !(Array.isArray(logins) && logins.every(l => typeof l === 'string'))) {
    throw new Error(`${path}: allowedLogins must be a list of Tailscale logins`)
  }
  const allowedLogins = (logins ?? []).map(l => l.trim()).filter(Boolean)
  if (allowedLogins.length) return { allowedLogins, trustedOwner: null }

  const owner = (await options.owner?.()) ?? null
  const config: GripConfig = { ...raw, allowedLogins: owner ? [owner] : [] }
  if (owner || raw === null) await writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`)
  return { allowedLogins: config.allowedLogins, trustedOwner: owner }
}
