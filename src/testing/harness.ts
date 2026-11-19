import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { onTestFinished } from 'vitest'

export const FAKE_CLAW_CLI = fileURLToPath(new URL('./fake-clawo.mjs', import.meta.url))

export async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'moxy-test-'))
  onTestFinished(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  return home
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

export const silentLog = () => {}
