import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { onTestFinished } from 'vitest'

import { exec, execOk } from '../exec.js'

export const FAKE_CLAW_CLI = fileURLToPath(new URL('./fake-clawo.mjs', import.meta.url))

export async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'moxy-test-'))
  onTestFinished(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  return home
}

export async function temporaryRepo(): Promise<string> {
  const repo = join(await temporaryHome(), 'repo')
  await mkdir(repo)
  const git = (...args: string[]) =>
    execOk(exec, 'git', ['-C', repo, '-c', 'user.name=Moxy Test', '-c', 'user.email=test@moxy.invalid', ...args])
  await git('init', '-q', '-b', 'main')
  await writeFile(join(repo, 'README.md'), '# test\n')
  await git('add', '.')
  await git('commit', '-q', '-m', 'start')
  return realpath(repo)
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
