import { join } from 'node:path'

import { exec as defaultExec } from '../exec.js'
import type { Exec } from '../exec.js'

const ELEVATED_LEVELS = ['S-1-16-12288', 'S-1-16-16384']

export async function isElevated(run: Exec = defaultExec, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform !== 'win32') return process.getuid?.() === 0
  const whoami = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe')
  const out = await run(whoami, ['/groups'], { timeoutMs: 15_000 })
  if (out.code !== 0) throw new Error(`whoami /groups: exit ${out.code}`)
  return ELEVATED_LEVELS.some(sid => out.stdout.includes(sid))
}

export async function assertNotElevated(run?: Exec, platform?: NodeJS.Platform): Promise<void> {
  if (await isElevated(run, platform)) {
    throw new Error('Moxy is running elevated. Run it from a normal terminal: workers must never get administrator rights.')
  }
}
