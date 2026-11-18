#!/usr/bin/env node
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ClawEngine } from './claw/index.js'
import { startDaemon } from './daemon.js'
import { loadOrCreateToken } from './fs-util.js'
import { install, mcpConfigText, status, stopAll, uninstall } from './install/commands.js'
import type { CommandContext } from './install/commands.js'
import { gripLogger } from './log.js'
import { gripPaths } from './paths.js'

const USAGE = `grip <command>

  install                                  Set Grip up on this machine and start it at every logon (Windows)
  status                                   Grip, its logon task, Tailscale and Claw, and what is working
  stop-all                                 Stop every worker and chat, like the app's Stop all
  uninstall                                Remove the logon task; Grip's data, Claw and tailscale serve stay
  serve [--engines claude,codex-app,agy]   Run Grip: Claw supervisor, the orchestrator MCP and the web API
  mcp-config                               Print how to add Grip's MCP server to an orchestrator

  --home <folder>   Grip's data folder instead of ~/.grip (or set GRIP_HOME)
`

/** Take `--name value` out of the arguments. */
function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name)
  if (at < 0) return undefined
  const value = args[at + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`)
  args.splice(at, 2)
  return value
}

async function main(argv: string[]) {
  const [command, ...rest] = argv
  const home = option(rest, '--home')
  if (home) process.env.GRIP_HOME = home
  const paths = gripPaths()
  const context: CommandContext = {
    home: paths.home,
    customHome: Boolean(process.env.GRIP_HOME),
    cli: fileURLToPath(import.meta.url),
  }

  if (command === 'serve') {
    const engines = option(rest, '--engines')?.split(',') as ClawEngine[] | undefined
    const log = gripLogger(join(paths.logs, 'grip.log'))
    process.on('uncaughtException', error => {
      log(`crashed: ${error.stack ?? error.message}`)
      process.exit(1)
    })
    const daemon = await startDaemon({ log, ...(engines ? { engines } : {}) }).catch((error: Error) => {
      log(`could not start: ${error.message}`)
      // Claw or the servers may have started; leave nothing running.
      process.exit(1)
    })
    const shutdown = () => {
      daemon.stop().then(
        () => process.exit(0),
        () => process.exit(1),
      )
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    // The console Grip runs in closing, as when the logon task is ended.
    process.once('SIGHUP', shutdown)
    return
  }

  if (command === 'mcp-config') return console.log(mcpConfigText(await loadOrCreateToken(join(paths.home, 'mcp-token'))))
  if (command === 'install') return install(context)
  if (command === 'uninstall') return uninstall(context)
  if (command === 'status') return status(context)
  if (command === 'stop-all') return stopAll(context)

  process.stdout.write(USAGE)
  process.exitCode = command ? 1 : 0
}

// An exit code instead of process.exit: exiting while fetch closes its sockets aborts Node on Windows.
main(process.argv.slice(2)).catch(error => {
  console.error(`grip: ${(error as Error).message}`)
  process.exitCode = 1
})
