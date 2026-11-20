import { setTimeout as sleep } from 'node:timers/promises'

export async function settlesWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return withTimeout(
    work.then(() => true),
    timeoutMs,
    () => false,
  )
}

export async function withTimeout<T>(work: Promise<T>, timeoutMs: number, timedOut: () => T): Promise<T> {
  const timer = new AbortController()
  try {
    return await Promise.race([work, sleep(timeoutMs, undefined, { signal: timer.signal }).then(timedOut)])
  } finally {
    timer.abort()
  }
}
