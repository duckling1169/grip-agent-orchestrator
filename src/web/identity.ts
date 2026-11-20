import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'

import { exec } from '../exec.js'
import { hasBearer, isLoopbackHost } from '../http.js'

export type Identity = { ok: true; login: string; local: boolean } | { ok: false; status: 401 | 403; error: string }

export const LOCAL_LOGIN = 'local'

export function identify(headers: IncomingHttpHeaders, allowedLogins: readonly string[], localToken: string): Identity {
  // Any process that reaches loopback can supply the Tailscale identity header.
  const raw = headers['tailscale-user-login']
  const login = (Array.isArray(raw) ? raw[0] : raw)?.trim()
  if (!login) {
    if (isLoopbackHost(headers.host) && hasBearer(headers.authorization, localToken)) return { ok: true, login: LOCAL_LOGIN, local: true }
    return { ok: false, status: 401, error: 'No Tailscale identity. Open Moxy through its Tailscale Serve address.' }
  }
  if (!allowedLogins.some(allowed => allowed.toLowerCase() === login.toLowerCase())) {
    const error =
      allowedLogins.length === 0
        ? `No Tailscale logins are allowed. Add ${login} to allowedLogins in Moxy's config.json.`
        : `${login} is not allowed. Add it to allowedLogins in Moxy's config.json.`
    return { ok: false, status: 403, error }
  }
  return { ok: true, login, local: false }
}

export function writeCheck(lookup = tailscaleHost) {
  let cached: { until: number; host: Promise<string | null> } | undefined
  return async (req: IncomingMessage, contentType = 'application/json'): Promise<string | null> => {
    if (req.method === 'GET' || req.method === 'HEAD') return null
    const type = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
    if (type !== contentType) return `Writes must send Content-Type: ${contentType}`
    const host = req.headers.host?.toLowerCase()
    let expected: string | undefined
    let originRequired = false
    if (host && isLoopbackHost(host)) {
      expected = new URL(`http://${host}`).origin
    } else if (host && /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net(?::443)?$/.test(host)) {
      if (!cached || cached.until <= Date.now()) cached = { until: Date.now() + 30_000, host: lookup() }
      const name = host.replace(/:443$/, '')
      const knownHost = await cached.host
      originRequired = knownHost === null
      if (originRequired || name === knownHost) expected = `https://${name}`
    }
    if (!expected) return 'Host is not a Moxy address'
    const origin = req.headers.origin
    return origin === expected || (!originRequired && origin === undefined) ? null : 'Origin must match the Moxy address'
  }
}

async function tailscaleHost(): Promise<string | null> {
  try {
    const result = await exec('tailscale', ['status', '--json'], { timeoutMs: 3000 })
    if (result.code !== 0) return null
    const status = JSON.parse(result.stdout) as { Self?: { DNSName?: string } }
    return status.Self?.DNSName?.toLowerCase().replace(/\.$/, '') || null
  } catch {
    return null
  }
}
