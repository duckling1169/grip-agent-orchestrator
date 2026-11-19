#!/usr/bin/env node
import { fileURLToPath } from 'node:url'

import { startMoxy } from './app.js'
import type { Moxy } from './app.js'
import { errorText } from './errors.js'
import { loadOrCreateToken } from './files.js'
import { fileLog } from './log.js'
import { moxyHome, moxyPaths } from './paths.js'
import { assertNotElevated } from './platform/elevation.js'
import { install, restart, status, stop, uninstall, upgradeClaw } from './platform/install.js'
import type { CommandContext } from './platform/install.js'
import { MoxyClient } from './web/client.js'
import { DEFAULT_WEB_PORT } from './web/server.js'

const USAGE = `moxy <command>

  install        Set Moxy up to start when you log on, and publish it with tailscale serve
  uninstall      Remove the logon task; keeps Moxy's data, Claw and tailscale serve
  status         Show whether Moxy runs, its logon task, Tailscale and Claw
  stop           Stop Moxy once nothing is working (--force stops it anyway)
  restart        Stop Moxy and start it again through its logon task (--force)
  upgrade-claw   Stop Moxy, install the newest supported Claw, and start Moxy again (--force)
  serve          Run Moxy in this console
  say <text>     Send Moxy a message and print its reply

  --home <folder>   Moxy's data folder instead of ~/.moxy (or set MOXY_HOME)
`

function takeOption(args: string[], name: string): string | undefined {
  const at = args.indexOf(name)
  if (at < 0) return undefined
  const value = args[at + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`)
  args.splice(at, 2)
  return value
}

function takeFlag(args: string[], name: string): boolean {
  const at = args.indexOf(name)
  if (at >= 0) args.splice(at, 1)
  return at >= 0
}

async function serve(home: string | undefined): Promise<void> {
  const log = fileLog(moxyPaths(home).moxyLog)
  process.on('uncaughtException', error => {
    log(`crashed: ${error.stack ?? error.message}`)
    process.exit(1)
  })
  let moxy: Moxy
  try {
    await assertNotElevated()
    moxy = await startMoxy({ ...(home ? { home } : {}), log })
  } catch (error) {
    log(`could not start: ${errorText(error)}`)
    throw error
  }
  const shutdown = () =>
    void moxy.stop().catch(error => {
      log(`stop failed: ${errorText(error)}`)
      process.exitCode = 1
    })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, shutdown)
  await moxy.stopped
  process.exit()
}

async function say(home: string | undefined, text: string): Promise<void> {
  if (!text.trim()) throw new Error('say needs a message')
  const client = new MoxyClient(`http://127.0.0.1:${DEFAULT_WEB_PORT}`, await loadOrCreateToken(moxyPaths(home).webToken))
  const posted = await client.post(text)
  const turn = await client.reply(posted.source)
  if (turn.output) process.stdout.write(`${turn.output}\n`)
  if (turn.error) {
    process.stderr.write(`moxy: ${turn.error}\n`)
    process.exitCode = 1
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv
  const home = takeOption(rest, '--home') ?? process.env.MOXY_HOME
  const force = takeFlag(rest, '--force')
  const context: CommandContext = { home: home ?? moxyHome(), customHome: home !== undefined, cli: fileURLToPath(import.meta.url) }
  if (command === 'serve') return serve(home)
  if (command === 'say') return say(home, rest.join(' '))
  if (command === 'install') return install(context)
  if (command === 'uninstall') return uninstall(context)
  if (command === 'status') return status(context)
  if (command === 'stop') return void (await stop(context, force))
  if (command === 'restart') return restart(context, force)
  if (command === 'upgrade-claw') return upgradeClaw(context, force)
  process.stdout.write(USAGE)
  process.exitCode = command ? 1 : 0
}

main(process.argv.slice(2)).catch(error => {
  console.error(`moxy: ${errorText(error)}`)
  process.exitCode = 1
})
