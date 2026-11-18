import { describe, expect, it } from 'vitest'

import type { GateResult } from './gate.js'
import type { ClawPackages } from './packages.js'
import { MemoryClawStateStore } from './state.js'
import { ClawSupervisor } from './supervisor.js'
import type { ClawRunner } from './supervisor.js'

class FakePackages implements ClawPackages {
  installs: string[] = []
  offline = false
  constructor(
    public current: string | null,
    public published: string[],
  ) {}
  async installed() {
    return this.current
  }
  async available() {
    if (this.offline) throw new Error('npm unreachable')
    return this.published
  }
  async install(version: string) {
    this.installs.push(version)
    this.current = version
  }
  async cliPath() {
    return '/fake/cli.js'
  }
}

class FakeRunner implements ClawRunner {
  running = false
  starts = 0
  stops = 0
  constructor(private readonly packages: FakePackages) {}
  async start() {
    this.running = true
    this.starts++
    return { version: this.packages.current ?? 'none' }
  }
  async stop() {
    this.running = false
    this.stops++
  }
}

const pass: GateResult = { ok: true, checks: [{ name: 'health', ok: true }] }
const fail: GateResult = { ok: false, checks: [{ name: 'codex-app session start', ok: false, detail: 'boom' }] }

function setup(opts: { current: string | null; published: string[]; gate?: (v: string) => GateResult; idle?: boolean; lastGood?: string }) {
  const packages = new FakePackages(opts.current, opts.published)
  const runner = new FakeRunner(packages)
  const store = new MemoryClawStateStore()
  if (opts.lastGood) store.state.lastGood = opts.lastGood
  const gated: string[] = []
  const supervisor = new ClawSupervisor({
    packages,
    runner,
    store,
    gate: async v => {
      gated.push(v)
      return (opts.gate ?? (() => pass))(v)
    },
    isIdle: async () => opts.idle ?? true,
    checkEveryMs: 1e9,
    now: () => new Date('2026-11-18T00:00:00Z'),
  })
  return { supervisor, packages, runner, store, gated }
}

describe('restart', () => {
  it('stops and starts Claw again on the same version, with no new gate', async () => {
    const t = setup({ current: '7.23.4', published: ['7.23.4'] })
    await t.supervisor.start()
    const statuses: string[] = []
    t.supervisor.on('status', s => statuses.push(s))
    await t.supervisor.restart()
    expect([t.runner.stops, t.runner.starts, t.gated.length]).toEqual([1, 2, 1])
    expect(statuses).toEqual(['starting', 'ready'])
    expect(t.supervisor.version).toBe('7.23.4')
  })
})

describe('boot', () => {
  it('loads update history and refreshes it after an update without exposing mutable state', async () => {
    const t = setup({ current: '7.23.4', published: ['7.23.4', '7.25.0'] })
    t.store.state.history.push({ at: '2026-11-17T00:00:00.000Z', kind: 'installed', from: null, to: '7.23.4' })
    await t.supervisor.start()
    expect(t.supervisor.history).toEqual(t.store.state.history)
    await t.supervisor.checkForUpdate()
    expect(t.supervisor.history).toEqual(t.store.state.history)
    expect(t.supervisor.history.at(-1)).toMatchObject({ kind: 'updated', from: '7.23.4', to: '7.25.0' })
    const copy = t.supervisor.history
    copy[0]!.kind = 'gate-failed'
    expect(t.supervisor.history[0]?.kind).toBe('installed')
    await t.supervisor.stop()
  })

  it('installs the newest in-range release when Claw is missing', async () => {
    const t = setup({ current: null, published: ['7.23.4', '7.24.0', '8.0.0'] })
    await t.supervisor.start()
    expect(t.packages.installs).toEqual(['7.24.0'])
    expect(t.supervisor.status).toBe('ready')
    expect(t.supervisor.version).toBe('7.24.0')
    expect(t.store.state.lastGood).toBe('7.24.0')
    await t.supervisor.stop()
  })

  it('keeps an installed in-range version without touching npm', async () => {
    const t = setup({ current: '7.23.4', published: [] })
    await t.supervisor.start()
    expect(t.packages.installs).toEqual([])
    expect(t.supervisor.status).toBe('ready')
    await t.supervisor.stop()
  })

  it('reinstalls the last good version when the installed one is out of range', async () => {
    const t = setup({ current: '8.0.0', published: ['7.25.0', '8.0.0'], lastGood: '7.23.4' })
    await t.supervisor.start()
    expect(t.packages.installs).toEqual(['7.23.4'])
    await t.supervisor.stop()
  })

  it('rolls back to the last good version when the installed one fails the gate', async () => {
    const t = setup({ current: '7.24.0', published: [], lastGood: '7.23.4', gate: v => (v === '7.24.0' ? fail : pass) })
    const rolled: unknown[] = []
    t.supervisor.on('rolled-back', e => rolled.push(e))
    await t.supervisor.start()
    expect(t.packages.current).toBe('7.23.4')
    expect(t.supervisor.version).toBe('7.23.4')
    expect(t.supervisor.status).toBe('ready')
    expect(t.store.state.rejected).toBe('7.24.0')
    expect(rolled).toHaveLength(1)
    await t.supervisor.stop()
  })

  it('stays up but degraded when the gate fails with nothing to fall back to', async () => {
    const t = setup({ current: '7.23.4', published: [], gate: () => fail })
    await t.supervisor.start()
    expect(t.supervisor.status).toBe('degraded')
    expect(t.runner.running).toBe(true)
    expect(t.store.state.history.at(-1)?.kind).toBe('gate-failed')
    await t.supervisor.stop()
  })
})

describe('checkForUpdate', () => {
  it('updates to the newest in-range release when idle and the gate passes', async () => {
    const t = setup({ current: '7.23.4', published: ['7.23.4', '7.25.0', '8.0.0'] })
    await t.supervisor.start()
    const outcome = await t.supervisor.checkForUpdate()
    expect(outcome).toEqual({ kind: 'updated', from: '7.23.4', to: '7.25.0' })
    expect(t.store.state.lastGood).toBe('7.25.0')
    expect(t.store.state.pendingMajor).toBe('8.0.0')
    expect(t.runner.stops).toBe(1)
    await t.supervisor.stop()
  })

  it('waits while workers are running', async () => {
    const t = setup({ current: '7.23.4', published: ['7.25.0'], idle: false })
    await t.supervisor.start()
    expect(await t.supervisor.checkForUpdate()).toEqual({ kind: 'deferred', reason: 'busy', target: '7.25.0' })
    expect(t.packages.installs).toEqual([])
    await t.supervisor.stop()
  })

  it('defers when npm is unreachable', async () => {
    const t = setup({ current: '7.23.4', published: ['7.25.0'] })
    await t.supervisor.start()
    t.packages.offline = true
    expect(await t.supervisor.checkForUpdate()).toEqual({ kind: 'deferred', reason: 'offline' })
    await t.supervisor.stop()
  })

  it('rolls back a release that fails the gate and does not retry it', async () => {
    const t = setup({ current: '7.23.4', published: ['7.23.4', '7.25.0'], gate: v => (v === '7.23.4' ? pass : fail) })
    await t.supervisor.start()
    const outcome = await t.supervisor.checkForUpdate()
    expect(outcome).toMatchObject({ kind: 'rolled-back', attempted: '7.25.0', to: '7.23.4' })
    expect(t.packages.current).toBe('7.23.4')
    expect(t.supervisor.status).toBe('ready')

    expect(await t.supervisor.checkForUpdate()).toEqual({ kind: 'up-to-date', version: '7.23.4' })
    expect(t.packages.installs).toEqual(['7.25.0', '7.23.4'])

    // A newer release than the rejected one is tried again.
    t.packages.published.push('7.25.1')
    expect(await t.supervisor.checkForUpdate()).toMatchObject({ kind: 'rolled-back', attempted: '7.25.1' })
    await t.supervisor.stop()
  })

  it('reports up-to-date when nothing newer is in range', async () => {
    const t = setup({ current: '7.25.0', published: ['7.25.0', '8.0.0'] })
    await t.supervisor.start()
    expect(await t.supervisor.checkForUpdate()).toEqual({ kind: 'up-to-date', version: '7.25.0' })
    await t.supervisor.stop()
  })
})

describe('whenReady', () => {
  it('waits through an update and resolves once Claw is back', async () => {
    const t = setup({ current: '7.23.4', published: ['7.25.0'] })
    let ready = false
    const waiting = t.supervisor.whenReady(1000).then(() => (ready = true))
    await new Promise(r => setTimeout(r, 10))
    expect(ready).toBe(false)
    await t.supervisor.start()
    await waiting
    expect(ready).toBe(true)
    await t.supervisor.stop()
  })

  it('gives up when Claw never comes up', async () => {
    const t = setup({ current: '7.23.4', published: [] })
    await expect(t.supervisor.whenReady(20)).rejects.toThrow('Claw is not ready (stopped)')
  })
})
