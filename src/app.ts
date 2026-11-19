import { Database } from './db/database.js'
import { MOXY_SCHEMA } from './db/schema.js'
import { errorText } from './errors.js'
import { loadOrCreateToken } from './files.js'
import { fileLog } from './log.js'
import type { Log } from './log.js'
import { moxyPaths } from './paths.js'
import type { MoxyPaths } from './paths.js'
import { ClawClient } from './runtime/claw/client.js'
import { assertSupportedClaw, installedClawCli } from './runtime/claw/install.js'
import { ClawProcess } from './runtime/claw/process.js'

export const DEFAULT_CLAW_PORT = 18796
const CLAW_MAX_SESSIONS = '64'

export type MoxyOptions = {
  home?: string
  clawPort?: number
  clawCli?: string
  log?: Log
}

export type Moxy = {
  paths: MoxyPaths
  database: Database
  clawPort: number
  clawVersion: string
  stop(): Promise<void>
}

export async function startMoxy(options: MoxyOptions = {}): Promise<Moxy> {
  const paths = moxyPaths(options.home)
  const log = options.log ?? fileLog(paths.moxyLog)
  const database = Database.open(paths.database, MOXY_SCHEMA)
  try {
    const clawPort = options.clawPort ?? DEFAULT_CLAW_PORT
    const claw = new ClawProcess({
      client: new ClawClient(`http://127.0.0.1:${clawPort}`, await loadOrCreateToken(paths.clawToken)),
      cliPath: options.clawCli ?? (await installedClawCli()),
      port: clawPort,
      logFile: paths.clawLog,
      env: { OPENCLAW_SERVE_MAX_SESSIONS: CLAW_MAX_SESSIONS },
    })
    claw.on('crashed', ({ code, restartInMs }) => log(`Claw exited with code ${code}; restarting in ${restartInMs / 1000} s`))
    claw.on('restartFailed', error => log(`Claw restart failed: ${errorText(error)}`))
    const { version } = await claw.start()
    try {
      assertSupportedClaw(version)
    } catch (error) {
      await claw.stop()
      throw error
    }
    log(`Claw ${version} on 127.0.0.1:${clawPort}`)

    let stopping: Promise<void> | null = null
    const stop = () =>
      (stopping ??= (async () => {
        log('stopping')
        await claw.stop()
        database.close()
      })())
    return { paths, database, clawPort, clawVersion: version, stop }
  } catch (error) {
    database.close()
    throw error
  }
}
