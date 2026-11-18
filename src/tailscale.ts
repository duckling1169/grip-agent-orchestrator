import { exec as defaultExec } from './exec.js'
import type { Exec } from './exec.js'

type Status = {
  BackendState?: string
  Self?: { UserID?: number; Tags?: string[] }
  User?: Record<string, { LoginName?: string }>
}

/**
 * The Tailscale login this machine is signed in to, from `tailscale status --json`. Null when
 * Tailscale is missing, not running, or the machine is tagged (a tagged machine has no owner).
 */
export async function tailscaleOwner(run: Exec = defaultExec): Promise<string | null> {
  let status: Status
  try {
    const out = await run('tailscale', ['status', '--json'], { timeoutMs: 15_000 })
    if (out.code !== 0) return null
    status = JSON.parse(out.stdout) as Status
  } catch {
    return null
  }
  if (status.BackendState !== 'Running' || status.Self?.Tags?.length) return null
  const id = status.Self?.UserID
  const login = id === undefined ? undefined : status.User?.[String(id)]?.LoginName
  return login?.trim() || null
}
