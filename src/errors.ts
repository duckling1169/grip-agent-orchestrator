/**
 * An error in words that keep its cause: the message, the system error code, and each nested
 * cause. `fetch failed` alone hid a timeout once; `fetch failed: Headers Timeout Error
 * (UND_ERR_HEADERS_TIMEOUT)` would not have.
 */
export function errorText(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; current && depth < 5; depth++) {
    if (!(current instanceof Error)) {
      parts.push(String(current))
      break
    }
    const code = (current as { code?: unknown }).code
    const text = typeof code === 'string' && !current.message.includes(code) ? `${current.message} (${code})` : current.message
    if (text && !parts.includes(text)) parts.push(text)
    current = current.cause
  }
  return parts.join(': ') || 'unknown error'
}

/** How long something took, for error messages: "after 7 min" or "after 42 s". */
export function afterText(startedAt: number, now = Date.now()): string {
  const seconds = Math.round((now - startedAt) / 1000)
  return seconds < 120 ? `after ${seconds} s` : `after ${Math.round(seconds / 60)} min`
}
