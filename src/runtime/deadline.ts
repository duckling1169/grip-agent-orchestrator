import { setTimeout as sleep } from 'node:timers/promises'

export async function settlesWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  const timer = new AbortController()
  try {
    return await Promise.race([work.then(() => true), sleep(timeoutMs, false, { signal: timer.signal })])
  } finally {
    timer.abort()
  }
}
