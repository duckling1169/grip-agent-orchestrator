import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Write a file whole or not at all: a crash mid-write leaves the old file in place. */
export async function writeFileAtomic(path: string, data: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, data, mode === undefined ? undefined : { mode })
  await rename(tmp, path)
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * The secret Grip hands Claw through `OPENCLAW_SERVER_TOKEN`. Grip owns it, so Claw never writes
 * `~/.openclaw/server-token`, and the token survives restarts without rotating.
 */
export async function loadOrCreateToken(path: string): Promise<string> {
  try {
    const existing = (await readFile(path, 'utf8')).trim()
    if (/^[0-9a-f]{64}$/.test(existing)) return existing
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const token = randomBytes(32).toString('hex')
  await writeFileAtomic(path, token, 0o600)
  return token
}
