import { homedir } from 'node:os'
import { join } from 'node:path'

import { samePath } from '../git/worktrees.js'

/**
 * Folders a worker may never be pointed at: Grip's and Claw's own state, SSH keys, the agents'
 * logins, and Tailscale's state. Pointing one at them could cut remote access, take over Grip, or
 * leak credentials. Home itself stays allowed, so "fix my network settings" still works.
 */
export function protectedFolders(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const list = [
    env.GRIP_HOME || join(home, '.grip'),
    join(home, '.ssh'),
    join(home, '.claude'),
    join(home, '.codex'),
    join(home, '.gemini'),
    join(home, '.openclaw'),
    join(home, '.claw-orchestrator'),
  ]
  if (process.platform === 'win32') {
    list.push(join(env.ProgramData || 'C:\\ProgramData', 'Tailscale'))
    if (env.LOCALAPPDATA) list.push(join(env.LOCALAPPDATA, 'Tailscale'))
  } else if (process.platform === 'darwin') {
    list.push('/Library/Tailscale', join(home, 'Library', 'Containers', 'io.tailscale.ipn.macsys'))
  } else {
    list.push('/var/lib/tailscale', '/etc/tailscale')
  }
  return list
}

/** The protected folder `path` is in (or is), or null. */
export function protectedFolderOf(path: string, folders = protectedFolders()): string | null {
  return folders.find(p => samePath(p, path) || isInside(path, p)) ?? null
}

function isInside(child: string, parent: string): boolean {
  const norm = (p: string) => {
    const s = p.replace(/[\\/]+/g, '/').replace(/\/$/, '')
    return process.platform === 'win32' ? s.toLowerCase() : s
  }
  return norm(child).startsWith(`${norm(parent)}/`)
}
