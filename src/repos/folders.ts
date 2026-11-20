import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

function comparable(path: string): string {
  const normalized = resolve(path)
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function samePath(a: string, b: string): boolean {
  return comparable(a) === comparable(b)
}

export function isWithin(path: string, folder: string): boolean {
  const child = comparable(path)
  const parent = comparable(folder)
  return child === parent || child.startsWith(`${parent}/`)
}

export function protectedFolders(moxyHome: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const folders = [
    moxyHome,
    join(home, '.ssh'),
    join(home, '.claude'),
    join(home, '.codex'),
    join(home, '.gemini'),
    join(home, '.openclaw'),
    join(home, '.claw-orchestrator'),
  ]
  if (process.platform === 'win32') {
    folders.push(join(env.ProgramData || 'C:\\ProgramData', 'Tailscale'))
    if (env.LOCALAPPDATA) folders.push(join(env.LOCALAPPDATA, 'Tailscale'))
  } else if (process.platform === 'darwin') {
    folders.push('/Library/Tailscale', join(home, 'Library', 'Containers', 'io.tailscale.ipn.macsys'))
  } else {
    folders.push('/var/lib/tailscale', '/etc/tailscale')
  }
  return folders
}

export function protectedFolderOf(path: string, folders: readonly string[]): string | null {
  return (
    folders.find(folder => {
      if (isWithin(path, folder)) return true
      try {
        return isWithin(path, realpathSync.native(folder))
      } catch {
        return false
      }
    }) ?? null
  )
}
