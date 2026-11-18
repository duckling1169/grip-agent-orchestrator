import { exec as defaultExec } from '../exec.js'
import type { Exec } from '../exec.js'

type ServeStatus = { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }

/** What `tailscale serve` does with `https://<this machine>/` today. */
export type ServeState = { kind: 'grip' } | { kind: 'none' } | { kind: 'other'; target: string } | { kind: 'unavailable'; reason: string }

const sameTarget = (proxy: string, port: number) =>
  [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `127.0.0.1:${port}`, `localhost:${port}`, String(port)].includes(
    proxy.replace(/\/$/, ''),
  )

const lastLine = (text: string) => text.trim().split(/\r?\n/).pop() ?? ''

/** Read the root of HTTPS port 443 from `tailscale serve status --json`. */
export function serveState(json: string, port: number): ServeState {
  let status: ServeStatus
  try {
    status = JSON.parse(json || '{}') as ServeStatus
  } catch {
    return { kind: 'unavailable', reason: 'tailscale serve status was not JSON' }
  }
  const root = Object.entries(status.Web ?? {}).find(([host]) => host.endsWith(':443'))?.[1]?.Handlers?.['/']
  if (!root) return { kind: 'none' }
  const target = root.Proxy ?? 'something other than a proxy'
  return root.Proxy && sameTarget(root.Proxy, port) ? { kind: 'grip' } : { kind: 'other', target }
}

/** What `tailscale serve` does with this machine's HTTPS root, without changing anything. */
export async function readServe(port: number, run: Exec = defaultExec): Promise<ServeState> {
  try {
    const out = await run('tailscale', ['serve', 'status', '--json'], { timeoutMs: 15_000 })
    if (out.code !== 0) return { kind: 'unavailable', reason: lastLine(out.stderr) || `exit ${out.code}` }
    return serveState(out.stdout, port)
  } catch (error) {
    return { kind: 'unavailable', reason: (error as Error).message }
  }
}

/** The command that publishes Grip's web port to your tailnet, for you to run yourself. */
export const serveCommand = (port: number) => `tailscale serve --bg ${port}`

/**
 * Publish Grip with `tailscale serve` when nothing serves this machine's HTTPS root yet (design
 * §15). It never replaces something else that is there; it says so and leaves it to you.
 */
export async function ensureServe(port: number, run: Exec = defaultExec): Promise<{ state: ServeState; changed: boolean }> {
  const before = await readServe(port, run)
  if (before.kind !== 'none') return { state: before, changed: false }
  const set = await run('tailscale', ['serve', '--bg', String(port)], { timeoutMs: 30_000 })
  if (set.code !== 0)
    return { state: { kind: 'unavailable', reason: lastLine(set.stderr || set.stdout) || `exit ${set.code}` }, changed: false }
  return { state: await readServe(port, run), changed: true }
}
