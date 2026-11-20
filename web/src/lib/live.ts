import { useEffect, useState } from 'react'

import type { Snapshot } from '@contracts/api'
import { api, RequestError } from '@/lib/api'

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'offline'

const OFFLINE_AFTER_MS = 15_000
const ACCESS_CHECK_MS = 5_000

export function useLiveState(): { snapshot: Snapshot | null; connection: Connection; denial: string | null } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [connection, setConnection] = useState<Connection>('connecting')
  const [denial, setDenial] = useState<string | null>(null)
  useEffect(() => {
    const events = new EventSource('/api/events')
    let offline: ReturnType<typeof setTimeout> | null = null
    let probe: AbortController | null = null
    const clearOffline = () => {
      if (offline) clearTimeout(offline)
      offline = null
    }
    events.addEventListener('state', event => {
      clearOffline()
      probe?.abort()
      setConnection('live')
      setSnapshot(JSON.parse((event as MessageEvent<string>).data) as Snapshot)
    })
    events.addEventListener('error', () => {
      setConnection(current => (current === 'offline' ? current : 'reconnecting'))
      offline ??= setTimeout(() => setConnection('offline'), OFFLINE_AFTER_MS)
      if (probe) return
      const controller = new AbortController()
      probe = controller
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(ACCESS_CHECK_MS)])
      void api
        .state(signal)
        .catch((error: unknown) => {
          if (signal.aborted || !(error instanceof RequestError) || (error.status !== 401 && error.status !== 403)) return
          clearOffline()
          events.close()
          setDenial(error.message)
        })
        .finally(() => {
          probe = null
        })
    })
    return () => {
      clearOffline()
      probe?.abort()
      events.close()
    }
  }, [])
  return { snapshot, connection, denial }
}
