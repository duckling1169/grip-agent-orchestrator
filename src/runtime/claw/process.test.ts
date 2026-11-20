import { readFile } from 'node:fs/promises'
import { ChildProcess } from 'node:child_process'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { freePort } from '../../ports.js'
import { listenOnLoopback, sendJson } from '../../http.js'
import { FAKE_CLAW_CLI, temporaryHome } from '../../testing/harness.js'
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

  it('verifies that the surviving server requires and recognizes the home token', async () => {
    let authRequired = true
    const server = await listenOnLoopback(0, async (req, res) => {
      const authorized = !authRequired || req.headers.authorization === `Bearer ${TOKEN}`
      sendJson(res, authorized ? 200 : 401, { ok: authorized, sessions: [] })
    })
    try {
      const url = `http://127.0.0.1:${server.port}`
      expect(await new ClawClient(url, TOKEN).verifyRecoveryToken()).toBe(true)
      await expect(new ClawClient(url, 'wrong').verifyRecoveryToken()).rejects.toThrow('HTTP 401')
      authRequired = false
      expect(await new ClawClient(url, TOKEN).verifyRecoveryToken()).toBe(false)
    } finally {
      await server.close()
    }
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

  it('reaches a deadline even when a child never exits after both signals', async () => {
    const logFile = join(await temporaryHome(), 'claw.log')
    const client = new ClawClient('http://127.0.0.1:1', TOKEN)
    vi.spyOn(client, 'health').mockResolvedValueOnce(null).mockResolvedValue({ version: '7.23.4', sessions: 0 })
    const child = Object.assign(new ChildProcess(), { pid: 12345 })
    const exec = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const claw = new ClawProcess({ client, cliPath: FAKE_CLAW_CLI, port: 1, logFile, spawn: () => child, exec, stopTimeoutMs: 40 })
    try {
      await claw.start()
      await expect(claw.stop()).rejects.toThrow('Claw did not exit within 40 ms')
      if (process.platform === 'win32') expect(exec).toHaveBeenCalledTimes(2)
      else
        expect(kill.mock.calls).toEqual([
          [-12345, 'SIGTERM'],
          [-12345, 'SIGKILL'],
        ])
    } finally {
      kill.mockRestore()
      child.emit('exit', null, 'SIGKILL')
    }
  })
})
