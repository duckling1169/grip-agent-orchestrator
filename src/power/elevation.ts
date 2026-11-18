import { join } from 'node:path'

import { exec as defaultExec } from '../exec.js'
import type { Exec } from '../exec.js'

/** Windows integrity levels at or above an elevated administrator's. */
const ELEVATED_LEVELS = ['S-1-16-12288', 'S-1-16-16384']

/**
 * Is this process elevated (an administrator token on Windows, root elsewhere)? Grip and its
 * workers must never be (design §9.2). On Windows, `whoami /groups` lists the token's mandatory
 * integrity level.
 */
export async function isElevated(run: Exec = defaultExec, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform !== 'win32') return process.getuid?.() === 0
  // By full path: Git for Windows puts its own, unrelated `whoami` first on PATH.
  const whoami = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe')
  const out = await run(whoami, ['/groups'], { timeoutMs: 15_000 })
  if (out.code !== 0) throw new Error(`whoami /groups: exit ${out.code}`)
  return ELEVATED_LEVELS.some(sid => out.stdout.includes(sid))
}

export async function assertNotElevated(run?: Exec): Promise<void> {
  if (await isElevated(run)) {
    throw new Error('Grip is running elevated. Run it from a normal terminal: workers must never get administrator rights.')
  }
}
