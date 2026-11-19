import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { writeFileAtomic } from './files.js'
import { QuotaRefreshMinutes } from './contracts/settings.js'

export type MoxyConfig = { allowedLogins: string[]; quotaRefreshMinutes: number; repoFolders: string[] }

const DEFAULT_QUOTA_REFRESH_MINUTES = 5

export async function loadConfig(path: string, owner: () => Promise<string | null>): Promise<MoxyConfig> {
  const raw = await readConfigFile(path)
  const logins = raw.allowedLogins ?? []
  if (!Array.isArray(logins) || !logins.every(login => typeof login === 'string')) {
    throw new Error(`${path}: allowedLogins must be a list of Tailscale logins`)
  }
  const minutes = QuotaRefreshMinutes.safeParse(raw.quotaRefreshMinutes ?? DEFAULT_QUOTA_REFRESH_MINUTES)
  if (!minutes.success) {
    throw new Error(`${path}: quotaRefreshMinutes must be 0 (off) or whole minutes from 1 to 1440`)
  }
  const repoFolders = raw.repoFolders ?? []
  if (!Array.isArray(repoFolders) || !repoFolders.every(folder => typeof folder === 'string' && isAbsolute(folder))) {
    throw new Error(`${path}: repoFolders must be a list of absolute folder paths`)
  }
  const allowedLogins = logins.map(login => login.trim()).filter(Boolean)
  if (allowedLogins.length === 0) {
    const login = await owner()
    if (login) {
      allowedLogins.push(login)
      await writeFileAtomic(path, `${JSON.stringify({ ...raw, allowedLogins }, null, 2)}\n`)
    }
  }
  return { allowedLogins, quotaRefreshMinutes: minutes.data, repoFolders }
}

export async function readConfigFile(path: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${path} must hold a JSON object`)
  return parsed as Record<string, unknown>
}
