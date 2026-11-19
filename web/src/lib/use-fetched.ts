import { useCallback, useEffect, useState } from 'react'

export type Fetched<T> = { data: T | null; error: string | null; reload: () => void }

export function useFetched<T>(load: (signal: AbortSignal) => Promise<T>, keys: unknown[], refreshMs: number | null = null): Fetched<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce(value => value + 1), [])
  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal).then(
      value => {
        setData(value)
        setError(null)
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure))
      },
    )
    return () => controller.abort()
  }, [...keys, nonce])
  useEffect(() => {
    if (refreshMs === null) return
    const timer = setInterval(reload, refreshMs)
    return () => clearInterval(timer)
  }, [refreshMs, reload])
  return { data, error, reload }
}
