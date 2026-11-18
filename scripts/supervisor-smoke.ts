// Drive the real supervisor against the real Claw on this machine: boot (install if needed,
// start, health gate), one update check, then stop. Set GRIP_HOME to keep it away from ~/.grip.
//   npx tsx scripts/supervisor-smoke.ts [engines=claude,codex-app,agy]
import { readFile } from 'node:fs/promises'

import { createClawSupervisor } from '../src/claw/index.js'
import type { ClawEngine } from '../src/claw/index.js'

const engines = (process.argv[2] ?? 'claude,codex-app,agy').split(',') as ClawEngine[]
const say = (event: string, data: unknown = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...(data as object) }))

const { supervisor, client, paths } = await createClawSupervisor({ engines })
supervisor.on('status', status => say('status', { status }))
supervisor.on('rolled-back', e => say('rolled-back', e))
supervisor.on('major-available', version => say('major-available', { version }))

try {
  const t0 = Date.now()
  await supervisor.start()
  say('booted', { status: supervisor.status, version: supervisor.version, ms: Date.now() - t0 })
  say('health', (await client.health()) ?? { health: null })
  say('update-check', await supervisor.checkForUpdate())
  say('state', JSON.parse(await readFile(paths.clawState, 'utf8')))
} catch (error) {
  say('error', { message: (error as Error).message })
  process.exitCode = 1
} finally {
  await supervisor.stop()
  say('stopped', { health: await client.health(500) })
}
