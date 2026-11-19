import { readFile } from 'node:fs/promises'

import { afterEach, describe, expect, it } from 'vitest'

import { startMoxy } from './app.js'
import type { Moxy, MoxyOptions } from './app.js'
import { DatabaseInUseError } from './db/database.js'
import { ClawClient } from './runtime/claw/client.js'
import { FAKE_CLAW_CLI, freePort, silentLog, temporaryHome } from './testing/harness.js'

const running: Moxy[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map(moxy => moxy.stop()))
})

async function start(options: MoxyOptions = {}) {
  const moxy = await startMoxy({
    home: await temporaryHome(),
    clawPort: await freePort(),
    clawCli: FAKE_CLAW_CLI,
    log: silentLog,
    ...options,
  })
  running.push(moxy)
  return moxy
}

describe('startMoxy', () => {
  it('starts Claw with a token kept in the data home', async () => {
    const moxy = await start()
    const token = await readFile(moxy.paths.clawToken, 'utf8')
    expect(moxy.clawVersion).toBe('7.23.4')
    expect(await new ClawClient(`http://127.0.0.1:${moxy.clawPort}`, token).health()).toMatchObject({ version: '7.23.4' })
  })

  it('stops Claw and releases the data home', async () => {
    const moxy = await start()
    const client = new ClawClient(`http://127.0.0.1:${moxy.clawPort}`, '')
    await moxy.stop()
    expect(await client.health(500)).toBeNull()

    await start({ home: moxy.paths.home })
  })

  it('refuses a second Moxy on the same data home without starting Claw', async () => {
    const first = await start()
    const secondPort = await freePort()
    await expect(start({ home: first.paths.home, clawPort: secondPort })).rejects.toThrow(DatabaseInUseError)
    expect(await new ClawClient(`http://127.0.0.1:${secondPort}`, '').health(500)).toBeNull()
  })

  it('refuses an unsupported Claw and leaves it stopped', async () => {
    process.env.FAKE_CLAW_VERSION = '8.0.0'
    const clawPort = await freePort()
    try {
      await expect(start({ clawPort })).rejects.toThrow('Claw 8.0.0 is not supported')
    } finally {
      delete process.env.FAKE_CLAW_VERSION
    }
    expect(await new ClawClient(`http://127.0.0.1:${clawPort}`, '').health(500)).toBeNull()
  })
})
