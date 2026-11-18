import type { IncomingHttpHeaders } from 'node:http'

export type Identity = { ok: true; login: string } | { ok: false; status: 401 | 403; error: string }

/**
 * Who is asking, from the `Tailscale-User-Login` header that `tailscale serve` adds (design
 * §9.1). Grip listens on loopback only, so a request without the header is a local process
 * calling the port directly, and is refused. Tagged devices get no header, so they are refused
 * too. `tailscale serve` replaces any such header a client sends, so a device cannot forge it.
 */
export function identify(headers: IncomingHttpHeaders, allowedLogins: readonly string[]): Identity {
  const raw = headers['tailscale-user-login']
  const login = (Array.isArray(raw) ? raw[0] : raw)?.trim()
  if (!login) return { ok: false, status: 401, error: 'No Tailscale identity. Open Grip through its tailscale serve address.' }
  const allowed = allowedLogins.some(a => a.toLowerCase() === login.toLowerCase())
  if (!allowed) return { ok: false, status: 403, error: `${login} is not allowed. Add it to allowedLogins in Grip's config.json.` }
  return { ok: true, login }
}

/**
 * Refuse a cross-site write. Every device on the tailnet gets the user's identity header added by
 * `tailscale serve`, so a page on another site could otherwise post to Grip from the user's own
 * browser. Writes must be JSON, which a cross-site page cannot send without a preflight Grip never
 * answers, and any Origin must be Grip's own.
 */
export function crossSiteWrite(method: string, headers: IncomingHttpHeaders): string | null {
  if (method === 'GET' || method === 'HEAD') return null
  const type = headers['content-type']?.split(';')[0]?.trim().toLowerCase()
  if (type !== 'application/json') return 'Writes must send Content-Type: application/json'
  const origin = headers.origin
  if (origin && origin !== 'null') {
    let host: string
    try {
      host = new URL(origin).host
    } catch {
      return 'Bad Origin header'
    }
    // A proxy may pass the address the browser used as X-Forwarded-Host instead of Host.
    const forwarded = headers['x-forwarded-host']
    const ours = [headers.host, ...(Array.isArray(forwarded) ? forwarded : [forwarded])].filter(Boolean).map(h => h!.toLowerCase())
    if (!ours.includes(host.toLowerCase())) return `Origin ${origin} may not write to Grip`
  } else if (origin === 'null') {
    return 'Origin null may not write to Grip'
  }
  return null
}
