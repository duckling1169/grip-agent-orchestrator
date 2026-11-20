import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { onTestFinished } from 'vitest'

import { initRepo } from './fixtures.js'

export async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'moxy-test-'))
  onTestFinished(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  return home
}

export async function temporaryRepo(): Promise<string> {
  const repo = join(await temporaryHome(), 'repo')
  await mkdir(repo)
  await initRepo(repo, 'Test')
  return realpath(repo)
}

export const silentLog = () => {}
