import { mkdtemp, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { ClawClient } from './client.js'
import { ClawProcess } from './process.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-clawo.mjs', import.meta.url))

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

let proc: ClawProcess | null = null
afterEach(async () => {
  await proc?.stop()
  proc = null
})

async function setup() {
  const port = await freePort()
  const dir = await mkdtemp(join(tmpdir(), 'grip-proc-'))
  const client = new ClawClient(`http://127.0.0.1:${port}`, 'x'.repeat(64))
  proc = new ClawProcess({ client, cliPath: async () => FAKE, port, token: 'x'.repeat(64), logFile: join(dir, 'claw.log'), backoffMs: [100], healthTimeoutMs: 5000 })
  return { port, client, logFile: join(dir, 'claw.log'), proc }
}

describe('ClawProcess', () => {
  it('starts, passes the token, logs output, and stops', async () => {
    const { client, logFile, proc } = await setup()
    expect(await proc.start()).toEqual({ version: '7.23.4' })
    expect(proc.running).toBe(true)
    const raw = (await (await fetch(`${client.baseUrl}/health`)).json()) as { token: boolean }
    expect(raw.token).toBe(true)
    await proc.stop()
    expect(proc.running).toBe(false)
    expect(await client.health(500)).toBeNull()
    expect(await readFile(logFile, 'utf8')).toContain('fake clawo on')
  })

  it('restarts after a crash', async () => {
    const { port, client, proc } = await setup()
    await proc.start()
    const firstPid = proc.pid
    const crashed = new Promise(resolve => proc.once('crashed', resolve))
    const restarted = new Promise(resolve => proc.once('started', resolve))
    await fetch(`http://127.0.0.1:${port}/crash`, { method: 'POST' }).catch(() => undefined)
    expect(await crashed).toMatchObject({ code: 3, restartInMs: 100 })
    await restarted
    expect(proc.pid).not.toBe(firstPid)
    expect(await client.health()).not.toBeNull()
  })

  it('refuses to start when the port already answers as Claw', async () => {
    const { port, proc: first } = await setup()
    await first.start()
    const second = new ClawProcess({
      client: new ClawClient(`http://127.0.0.1:${port}`, 'x'.repeat(64)),
      cliPath: async () => FAKE,
      port,
      token: 'x'.repeat(64),
      logFile: join(tmpdir(), 'grip-unused.log'),
    })
    await expect(second.start()).rejects.toThrow('already answers')
  })

  it('does not restart after a deliberate stop', async () => {
    const { proc } = await setup()
    await proc.start()
    let crashes = 0
    proc.on('crashed', () => crashes++)
    await proc.stop()
    await new Promise(r => setTimeout(r, 300))
    expect(crashes).toBe(0)
    expect(proc.running).toBe(false)
  })
})
