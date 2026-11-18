import { exec as defaultExec } from '../exec.js'
import type { Exec } from '../exec.js'

/** A machine on the tailnet, for the app's machine switcher. */
export type Machine = {
  /** The Tailscale machine name, e.g. `windows-pc`. */
  name: string
  dnsName: string
  /** Tailnet IPs, IPv4 first. */
  ips: string[]
  os: string
  online: boolean
  /** The machine this Grip runs on. */
  self: boolean
  /** Whether Grip answers on that machine's tailnet address. */
  grip: 'yes' | 'no' | 'unknown'
  /** Where that machine's Grip is, when it runs one. */
  url: string | null
}

export type MachineList = { machines: Machine[] }

type Node = { HostName?: string; DNSName?: string; OS?: string; Online?: boolean; TailscaleIPs?: string[] }
type Status = { Self?: Node; Peer?: Record<string, Node> }

export type MachineOptions = {
  exec?: Exec
  /** Asks a machine's `/health`; true when Grip answers. */
  probe?: (url: string) => Promise<boolean>
}

/** Phones and tablets can't run Grip, so they are never asked. */
const MOBILE = new Set(['ios', 'android'])

/**
 * Tailnet machines from `tailscale status --json`, each online computer asked whether it runs
 * Grip. Each Grip stays independent: switching machines in the app opens that machine's Grip.
 */
export async function listMachines(options: MachineOptions = {}): Promise<MachineList> {
  const run = options.exec ?? defaultExec
  const probe = options.probe ?? probeGrip
  const out = await run('tailscale', ['status', '--json'], { timeoutMs: 15_000 })
  if (out.code !== 0) throw new Error(`tailscale status: ${out.stderr.trim().split(/\r?\n/).pop() || `exit ${out.code}`}`)
  const status = JSON.parse(out.stdout) as Status
  const nodes = [
    ...(status.Self ? [{ node: status.Self, self: true }] : []),
    ...Object.values(status.Peer ?? {}).map(node => ({ node, self: false })),
  ]
  const machines = await Promise.all(
    nodes.map(async ({ node, self }): Promise<Machine> => {
      const dnsName = (node.DNSName ?? '').replace(/\.$/, '')
      const url = dnsName ? `https://${dnsName}/` : null
      const online = self || node.Online === true
      const os = node.OS ?? ''
      let grip: Machine['grip'] = self ? 'yes' : 'unknown'
      if (!self) {
        if (!online || MOBILE.has(os.toLowerCase()) || !url) grip = online ? 'no' : 'unknown'
        else grip = (await probe(url).catch(() => false)) ? 'yes' : 'no'
      }
      return {
        name: dnsName.split('.')[0] || node.HostName || 'unknown',
        dnsName,
        ips: [...(node.TailscaleIPs ?? [])].sort((a, b) => Number(a.includes(':')) - Number(b.includes(':'))),
        os,
        online,
        self,
        grip,
        url: grip === 'yes' ? url : null,
      }
    }),
  )
  const rank = (m: Machine) => (m.self ? 0 : m.grip === 'yes' ? 1 : m.online ? 2 : 3)
  return { machines: machines.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)) }
}

/**
 * This tailnet's DNS suffix, such as `.example-tailnet.ts.net`, from this machine's own name. Null
 * when Tailscale can't be read, so no other machine's app is trusted.
 */
export async function tailnetSuffix(exec: Exec = defaultExec): Promise<string | null> {
  try {
    const out = await exec('tailscale', ['status', '--json'], { timeoutMs: 15_000 })
    if (out.code !== 0) return null
    const name = ((JSON.parse(out.stdout) as Status).Self?.DNSName ?? '').replace(/.$/, '').toLowerCase()
    const dot = name.indexOf('.')
    return dot > 0 && name.indexOf('.', dot + 1) > 0 ? name.slice(dot) : null
  } catch {
    return null
  }
}

/** Grip's `/health` names the app, so another web server on port 443 is not mistaken for it. */
async function probeGrip(url: string): Promise<boolean> {
  const res = await fetch(new URL('health', url), { signal: AbortSignal.timeout(3000) })
  if (!res.ok) return false
  const body = (await res.json().catch(() => null)) as { app?: unknown } | null
  return body?.app === 'grip'
}
