// Adapted from Grip's src/web/machines.ts; discovers peers through Tailscale's official status command.

import { hostname } from 'node:os'

import type { Machine, MachineList } from '../contracts/machines.js'
import { errorText, lastLine } from '../errors.js'
import { exec as defaultExec } from '../exec.js'
import type { Exec } from '../exec.js'

type Node = Record<string, unknown>
export type MachineOptions = {
  exec?: Exec
  probe?: (url: string, signal: AbortSignal) => Promise<boolean>
  now?: () => number
  cacheMs?: number
  timeoutMs?: number
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const DNS = new RegExp(`^${LABEL}\\.${LABEL}\\.ts\\.net$`)
const MOBILE = new Set(['android', 'ios', 'ipados'])
const MAX_PEERS = 128

export class MachineDiscovery {
  private readonly run: Exec
  private readonly probe: NonNullable<MachineOptions['probe']>
  private readonly now: () => number
  private readonly cacheMs: number
  private readonly timeoutMs: number
  private cached: MachineList | null = null
  private cachedAt = -Infinity
  private inFlight: Promise<MachineList> | null = null

  constructor(options: MachineOptions = {}) {
    this.run = options.exec ?? defaultExec
    this.probe = options.probe ?? probeMoxy
    this.now = options.now ?? Date.now
    this.cacheMs = Math.max(0, options.cacheMs ?? 30000)
    this.timeoutMs = Math.max(1, Math.min(3000, options.timeoutMs ?? 3000))
  }

  get(): Promise<MachineList> {
    if (this.inFlight) return this.inFlight
    if (this.cached && this.now() - this.cachedAt < this.cacheMs) return Promise.resolve(this.cached)
    return this.refresh()
  }

  refresh(): Promise<MachineList> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.discover()
      .then(result => {
        this.cached = result
        this.cachedAt = this.now()
        return result
      })
      .finally(() => {
        this.inFlight = null
      })
    return this.inFlight
  }

  private async discover(): Promise<MachineList> {
    try {
      const output = await this.run('tailscale', ['status', '--json'], { timeoutMs: 15000 })
      if (output.code !== 0) throw new Error(`Tailscale status: ${lastLine(output.stderr) || `exit ${output.code}`}`)
      const status: unknown = JSON.parse(output.stdout)
      if (!object(status)) throw new Error('Invalid Tailscale status')
      if (typeof status.BackendState === 'string' && status.BackendState !== 'Running')
        throw new Error(`Tailscale is ${status.BackendState}`)
      if (!object(status.Self)) throw new Error('Invalid Tailscale status: missing this machine')
      const ownName = dnsName(status.Self.DNSName)
      const suffix = ownName ? ownName.slice(ownName.indexOf('.')) : null
      const peers = object(status.Peer) ? Object.entries(status.Peer).filter((entry): entry is [string, Node] => object(entry[1])) : []
      const nodes = [
        { key: 'self', node: status.Self, self: true },
        ...peers.slice(0, MAX_PEERS).map(([key, node]) => ({ key, node, self: false })),
      ]
      const machines = nodes.map(({ key, node, self }): Machine => {
        const dns = dnsName(node.DNSName)
        return {
          id: self ? 'self' : dns || `peer-${key.slice(0, 128)}`,
          name: dns.split('.')[0] || text(node.HostName).slice(0, 200) || 'unknown',
          dnsName: dns,
          self,
          online: node.Online === true,
          moxy: self ? 'yes' : 'unknown',
          url: self && ownName ? `https://${ownName}/` : null,
        }
      })
      const budget = AbortSignal.timeout(10000)
      let next = 1
      let limited = peers.length > MAX_PEERS
      const work = async () => {
        for (let index = next++; index < nodes.length; index = next++) {
          const item = nodes[index]!
          const machine = machines[index]!
          if (
            !suffix ||
            !machine.dnsName.endsWith(suffix) ||
            machine.dnsName === ownName ||
            !machine.online ||
            MOBILE.has(text(item.node.OS).toLowerCase())
          )
            continue
          if (budget.aborted) {
            limited = true
            continue
          }
          const signal = AbortSignal.any([budget, AbortSignal.timeout(this.timeoutMs)])
          try {
            const detected = await boundedProbe(this.probe, `https://${machine.dnsName}/health`, signal)
            machine.moxy = detected ? 'yes' : 'no'
            machine.url = detected ? `https://${machine.dnsName}/` : null
          } catch {
            machine.moxy = 'unknown'
          }
        }
      }
      await Promise.all(Array.from({ length: 4 }, work))
      const rank = (machine: Machine) => (machine.self ? 0 : machine.moxy === 'yes' ? 1 : machine.online ? 2 : 3)
      machines.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
      return {
        machines,
        checkedAt: new Date(this.now()).toISOString(),
        error: !suffix
          ? 'This machine has no valid tailnet DNS name; peer Moxy apps were not checked.'
          : limited
            ? 'Machine discovery was limited; some tailnet peers were not checked.'
            : null,
      }
    } catch (error) {
      return {
        machines: [{ id: 'self', name: hostname(), dnsName: '', self: true, online: false, moxy: 'yes', url: null }],
        checkedAt: new Date(this.now()).toISOString(),
        error: `Machine discovery unavailable: ${errorText(error)}`,
      }
    }
  }
}

function object(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function dnsName(value: unknown): string {
  const name = text(value).toLowerCase().replace(/\.$/, '')
  return DNS.test(name) ? name : ''
}

async function boundedProbe(probe: NonNullable<MachineOptions['probe']>, url: string, signal: AbortSignal): Promise<boolean> {
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      probe(url, signal),
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error('Machine health check timed out'))
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      }),
    ])
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
  }
}

async function probeMoxy(url: string, signal: AbortSignal): Promise<boolean> {
  const response = await fetch(url, { redirect: 'error', credentials: 'omit', signal })
  if (!response.ok) return false
  const reader = response.body?.getReader()
  if (!reader) return false
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > 16384) return false
      chunks.push(value)
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return object(body) && body.app === 'moxy'
  } catch {
    return false
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
