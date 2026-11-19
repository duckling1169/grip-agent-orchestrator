#!/usr/bin/env node
import { startMoxy } from './app.js'
import type { Moxy } from './app.js'
import { errorText } from './errors.js'
import { fileLog } from './log.js'
import { moxyPaths } from './paths.js'

const USAGE = `moxy <command>

  serve    Run Moxy in this console

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

async function serve(home: string | undefined): Promise<void> {
  const log = fileLog(moxyPaths(home).moxyLog)
  process.on('uncaughtException', error => {
    log(`crashed: ${error.stack ?? error.message}`)
    process.exit(1)
  })
  let moxy: Moxy
  try {
    moxy = await startMoxy({ ...(home ? { home } : {}), log })
  } catch (error) {
    log(`could not start: ${errorText(error)}`)
    process.exitCode = 1
    return
  }
  const shutdown = () => {
    moxy.stop().then(
      () => (process.exitCode = 0),
      error => {
        log(`stop failed: ${errorText(error)}`)
        process.exitCode = 1
      },
    )
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, shutdown)
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv
  const home = takeOption(rest, '--home') ?? process.env.MOXY_HOME
  if (command === 'serve') return serve(home)
  process.stdout.write(USAGE)
  process.exitCode = command ? 1 : 0
}

main(process.argv.slice(2)).catch(error => {
  console.error(`moxy: ${errorText(error)}`)
  process.exitCode = 1
})
