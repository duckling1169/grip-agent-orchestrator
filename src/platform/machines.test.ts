import { afterEach, describe, expect, it, vi } from 'vitest'

import { MachineDiscovery } from './machines.js'
import type { Exec } from '../exec.js'

const status = () => ({
  BackendState: 'Running',
  Self: { HostName: 'Desktop', DNSName: 'desktop.tail.ts.net.', Online: true },
  Peer: {
    mac: { HostName: 'Mac', DNSName: 'mac.tail.ts.net.', Online: true, OS: 'macOS' },
    linux: { HostName: 'Linux', DNSName: 'linux.tail.ts.net.', Online: true, OS: 'linux' },
    phone: { HostName: 'Phone', DNSName: 'phone.tail.ts.net.', Online: true, OS: 'iOS' },
    offline: { HostName: 'Old', DNSName: 'old.tail.ts.net.', Online: false, OS: 'windows' },
  },
})
const run =
  (value: unknown): Exec =>
  async (command, args, options) => {
    expect(command).toBe('tailscale')
    expect(args).toEqual(['status', '--json'])
    expect(options?.timeoutMs).toBe(15000)
    return { code: 0, stdout: JSON.stringify(value), stderr: '' }
  }
afterEach(() => vi.unstubAllGlobals())

describe('MachineDiscovery', () => {
  it('includes self and distinguishes online tailnet peers from detected Moxy apps', async () => {
    const urls: string[] = []
    const discovery = new MachineDiscovery({
      exec: run(status()),
      probe: async url => {
        urls.push(url)
        return url.includes('linux')
      },
    })
    const list = await discovery.get()
    expect(urls.sort()).toEqual(['https://linux.tail.ts.net/health', 'https://mac.tail.ts.net/health'])
    expect(list.error).toBeNull()
    expect(list.machines.map(machine => [machine.name, machine.online, machine.moxy, machine.url])).toEqual([
      ['desktop', true, 'yes', 'https://desktop.tail.ts.net/'],
      ['linux', true, 'yes', 'https://linux.tail.ts.net/'],
      ['mac', true, 'no', null],
      ['phone', true, 'unknown', null],
      ['old', false, 'unknown', null],
    ])
  })

  it('caches and deduplicates callers and refreshes only when requested or stale', async () => {
    let reads = 0
    let now = 1000
    const discovery = new MachineDiscovery({
      exec: async (...args) => {
        reads++
        return run(status())(...args)
      },
      now: () => now,
      probe: async () => false,
    })
    const [a, b] = await Promise.all([discovery.get(), discovery.get()])
    expect(a).toEqual(b)
    await discovery.get()
    expect(reads).toBe(1)
    await Promise.all([discovery.refresh(), discovery.refresh()])
    expect(reads).toBe(2)
    now += 30001
    await discovery.get()
    expect(reads).toBe(3)
  })

  it('never probes arbitrary URLs, IPs, credentials or another tailnet', async () => {
    const value = status()
    const invalid = [
      'https://bad.tail.ts.net',
      '127.0.0.1',
      'bad.other.ts.net',
      'bad.tail.ts.net.evil.test',
      'user@bad.tail.ts.net',
      'bad.tail.ts.net:443',
      'nested.bad.tail.ts.net',
      'bad.tail.ts.net/path',
    ]
    value.Peer = Object.fromEntries(
      invalid.map((DNSName, i) => [String(i), { HostName: 'unsafe', DNSName, Online: true, OS: 'linux' }]),
    ) as typeof value.Peer
    const probe = vi.fn(async () => true)
    const list = await new MachineDiscovery({ exec: run(value), probe }).get()
    expect(probe).not.toHaveBeenCalled()
    expect(list.machines.slice(1).every(machine => machine.url === null && machine.moxy === 'unknown')).toBe(true)
    value.Self.DNSName = 'desktop.evil.test.'
    const badSelf = await new MachineDiscovery({ exec: run(value), probe }).get()
    expect(badSelf.error).toContain('tailnet DNS')
    expect(probe).not.toHaveBeenCalled()
  })

  it('returns a clear error and self when Tailscale is unavailable or malformed', async () => {
    const absent = await new MachineDiscovery({
      exec: async () => {
        throw new Error('not installed')
      },
    }).get()
    expect(absent.error).toContain('not installed')
    expect(absent.machines).toMatchObject([{ self: true, moxy: 'yes', url: null, online: false }])
    expect((await new MachineDiscovery({ exec: run({ BackendState: 'Stopped' }) }).get()).error).toContain('Stopped')
    expect((await new MachineDiscovery({ exec: run('bad status') }).get()).error).toContain('Invalid')
  })

  it('bounds concurrent and stalled probes without confusing unknown availability with offline', async () => {
    const value = status()
    value.Peer = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        String(i),
        { HostName: `peer${i}`, DNSName: `peer${i}.tail.ts.net`, Online: true, OS: 'linux' },
      ]),
    ) as typeof value.Peer
    let active = 0
    let peak = 0
    const discovery = new MachineDiscovery({
      exec: run(value),
      timeoutMs: 20,
      probe: async url => {
        active++
        peak = Math.max(peak, active)
        if (url.includes('peer8.')) return new Promise(() => {})
        await new Promise(resolve => setTimeout(resolve, 2))
        active--
        return false
      },
    })
    const list = await discovery.get()
    expect(peak).toBeLessThanOrEqual(4)
    expect(list.machines.find(machine => machine.name === 'peer8')).toMatchObject({ online: true, moxy: 'unknown', url: null })
  })

  it('uses only the public health identity without credentials or redirects', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
      expect(options).toMatchObject({ redirect: 'error', credentials: 'omit' })
      expect(options?.headers).toBeUndefined()
      return Response.json({ app: 'moxy', ok: true })
    })
    vi.stubGlobal('fetch', fetch)
    const list = await new MachineDiscovery({ exec: run(status()) }).get()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(list.machines.filter(machine => machine.moxy === 'yes')).toHaveLength(3)
    vi.stubGlobal('fetch', async () => Response.json({ app: 'other' }))
    const other = await new MachineDiscovery({ exec: run(status()) }).get()
    expect(other.machines.find(machine => machine.name === 'mac')?.moxy).toBe('no')
  })

  it('refuses redirects, oversized health responses and non-string app identities', async () => {
    for (const response of [
      () => new Response(null, { status: 302, headers: { Location: 'https://outside.example/' } }),
      () => new Response(JSON.stringify({ app: 'moxy', huge: 'x'.repeat(20000) })),
      () => Response.json({ app: ['moxy'] }),
    ]) {
      const fetch = vi.fn(async () => response())
      vi.stubGlobal('fetch', fetch)
      const list = await new MachineDiscovery({ exec: run(status()) }).get()
      expect(list.machines.filter(machine => machine.moxy === 'yes')).toHaveLength(1)
      expect(fetch).toHaveBeenCalledTimes(2)
    }
  })
})
