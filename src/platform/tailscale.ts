import { errorText, lastLine } from '../errors.js'
import { exec as defaultExec } from '../exec.js'
import type { Exec } from '../exec.js'

type Status = {
  BackendState?: string
  Self?: { UserID?: number; Tags?: string[] }
  User?: Record<string, { LoginName?: string }>
}

export async function tailscaleOwner(run: Exec = defaultExec): Promise<string | null> {
  let status: Status
  try {
    const out = await run('tailscale', ['status', '--json'], { timeoutMs: 15_000 })
    if (out.code !== 0) return null
    status = JSON.parse(out.stdout) as Status
  } catch {
    return null
  }
  if (status.BackendState !== 'Running' || status.Self?.Tags?.length) return null
  const id = status.Self?.UserID
  const login = id === undefined ? undefined : status.User?.[String(id)]?.LoginName
  return login?.trim() || null
}

export type ServeState = { kind: 'moxy' } | { kind: 'none' } | { kind: 'other'; target: string } | { kind: 'unavailable'; reason: string }

type ServeStatus = { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }

export const serveCommand = (port: number) => `tailscale serve --bg ${port}`

export function serveState(json: string, port: number): ServeState {
  let status: ServeStatus
  try {
    status = JSON.parse(json || '{}') as ServeStatus
  } catch {
    return { kind: 'unavailable', reason: 'tailscale serve status was not JSON' }
  }
  const root = Object.entries(status.Web ?? {}).find(([host]) => host.endsWith(':443'))?.[1]?.Handlers?.['/']
  if (!root) return { kind: 'none' }
  const proxy = root.Proxy?.replace(/\/$/, '')
  const ours = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `127.0.0.1:${port}`, `localhost:${port}`, String(port)]
  return proxy && ours.includes(proxy) ? { kind: 'moxy' } : { kind: 'other', target: root.Proxy ?? 'something other than a proxy' }
}

export async function readServe(port: number, run: Exec = defaultExec): Promise<ServeState> {
  try {
    const out = await run('tailscale', ['serve', 'status', '--json'], { timeoutMs: 15_000 })
    if (out.code !== 0) return { kind: 'unavailable', reason: lastLine(out.stderr) || `exit ${out.code}` }
    return serveState(out.stdout, port)
  } catch (error) {
    return { kind: 'unavailable', reason: errorText(error) }
  }
}

export async function ensureServe(port: number, run: Exec = defaultExec): Promise<{ state: ServeState; changed: boolean }> {
  const before = await readServe(port, run)
  if (before.kind !== 'none') return { state: before, changed: false }
  const set = await run('tailscale', ['serve', '--bg', String(port)], { timeoutMs: 30_000 })
  if (set.code !== 0)
    return { state: { kind: 'unavailable', reason: lastLine(set.stderr || set.stdout) || `exit ${set.code}` }, changed: false }
  return { state: await readServe(port, run), changed: true }
}
