import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export async function writeFileAtomic(path: string, data: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, data, mode === undefined ? undefined : { mode })
  await rename(temporary, path)
}

export async function loadOrCreateToken(path: string): Promise<string> {
  try {
    const existing = (await readFile(path, 'utf8')).trim()
    if (/^[0-9a-f]{64}$/.test(existing)) return existing
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  const token = randomBytes(32).toString('hex')
  await writeFileAtomic(path, token, 0o600)
  return token
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export async function inTempFolder<T>(work: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'moxy-probe-'))
  try {
    return await work(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
  }
}
