import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { exec, execOk } from '../exec.js'

export const FAKE_CLAW_CLI = fileURLToPath(new URL('./fake-clawo.mjs', import.meta.url))

export async function waitUntil(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !done(); attempt++) await sleep(5)
}

export async function initRepo(repo: string, user: string): Promise<void> {
  const git = (...args: string[]) => execOk(exec, 'git', ['-C', repo, ...args])
  await git('init', '-q', '-b', 'main')
  await git('config', 'user.name', `Moxy ${user}`)
  await git('config', 'user.email', `${user.toLowerCase()}@moxy.invalid`)
  await writeFile(join(repo, 'README.md'), `# ${user.toLowerCase()}\n`)
  await git('add', '.')
  await git('commit', '-q', '-m', 'start')
}
