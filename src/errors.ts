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

export function elapsedText(startedAt: number, now = Date.now()): string {
  const seconds = Math.round((now - startedAt) / 1000)
  return seconds < 120 ? `after ${seconds} s` : `after ${Math.round(seconds / 60)} min`
}

export function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).pop() ?? ''
}
