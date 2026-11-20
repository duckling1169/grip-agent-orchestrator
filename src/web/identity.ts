import { timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

export type Identity = { ok: true; login: string } | { ok: false; status: 401 | 403; error: string }

export const LOCAL_LOGIN = 'local'

export function identify(headers: IncomingHttpHeaders, allowedLogins: readonly string[], localToken: string): Identity {
  const raw = headers['tailscale-user-login']
  const login = (Array.isArray(raw) ? raw[0] : raw)?.trim()
  if (!login) {
    if (hasBearer(headers.authorization, localToken)) return { ok: true, login: LOCAL_LOGIN }
    return { ok: false, status: 401, error: 'No Tailscale identity. Open Moxy through its tailscale serve address.' }
  }
  if (!allowedLogins.some(allowed => allowed.toLowerCase() === login.toLowerCase())) {
    return { ok: false, status: 403, error: `${login} is not allowed. Add it to allowedLogins in Moxy's config.json.` }
  }
  return { ok: true, login }
}

export function crossSiteWrite(method: string, headers: IncomingHttpHeaders, contentType = 'application/json'): string | null {
  if (method === 'GET' || method === 'HEAD') return null
  const type = headers['content-type']?.split(';')[0]?.trim().toLowerCase()
  if (type !== contentType) return `Writes must send Content-Type: ${contentType}`
  const origin = headers.origin
  if (origin === undefined) return null
  let host: string
  try {
    host = new URL(origin).host.toLowerCase()
  } catch {
    return `Origin ${origin} may not write to Moxy`
  }
  const forwarded = headers['x-forwarded-host']
  const ours = [headers.host, ...(Array.isArray(forwarded) ? forwarded : [forwarded])].flatMap(name => (name ? [name.toLowerCase()] : []))
  return ours.includes(host) ? null : `Origin ${origin} may not write to Moxy`
}

function hasBearer(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
