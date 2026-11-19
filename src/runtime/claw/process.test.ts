import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FAKE_CLAW_CLI, freePort, temporaryHome } from '../../testing/harness.js'
import { ClawClient } from './client.js'
import { ClawProcess } from './process.js'

const TOKEN = 'a'.repeat(64)
const started: ClawProcess[] = []

afterEach(async () => {
  await Promise.all(started.splice(0).map(claw => claw.stop()))
})

async function clawProcess(port?: number) {
  const clawPort = port ?? (await freePort())
  const logFile = join(await temporaryHome(), 'claw.log')
  const client = new ClawClient(`http://127.0.0.1:${clawPort}`, TOKEN)
  const claw = new ClawProcess({ client, cliPath: FAKE_CLAW_CLI, port: clawPort, logFile, restartDelaysMs: [100], healthTimeoutMs: 5000 })
  started.push(claw)
  return { claw, client, port: clawPort, logFile }
}

describe('ClawProcess', () => {
  it('starts with the token, logs its output and stops', async () => {
    const { claw, client, logFile } = await clawProcess()
    expect(await claw.start()).toEqual({ version: '7.23.4' })
    const health = (await (await fetch(`${client.baseUrl}/health`)).json()) as { token: boolean }
    expect(health.token).toBe(true)

    await claw.stop()
    expect(claw.running).toBe(false)
    expect(await client.health(500)).toBeNull()
    expect(await readFile(logFile, 'utf8')).toContain('fake clawo on')
  })

  it('restarts after a crash', async () => {
    const { claw, client, port } = await clawProcess()
    await claw.start()
    const firstPid = claw.pid
    const crashed = new Promise(resolve => claw.once('crashed', resolve))
    const restarted = new Promise(resolve => claw.once('started', resolve))
    await fetch(`http://127.0.0.1:${port}/crash`, { method: 'POST' }).catch(() => undefined)

    expect(await crashed).toMatchObject({ code: 3, restartInMs: 100 })
    await restarted
    expect(claw.pid).not.toBe(firstPid)
    expect(await client.health()).not.toBeNull()
  })

  it('refuses to start when the port already answers as Claw', async () => {
    const { claw, port } = await clawProcess()
    await claw.start()
    const { claw: second } = await clawProcess(port)
    await expect(second.start()).rejects.toThrow('already answers')
  })

  it('does not restart after a deliberate stop', async () => {
    const { claw } = await clawProcess()
    await claw.start()
    let crashes = 0
    claw.on('crashed', () => crashes++)
    await claw.stop()
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(crashes).toBe(0)
    expect(claw.running).toBe(false)
  })
})
