import { useEffect, useState } from 'react'

import type { Snapshot } from '@contracts/api'

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'offline'

const OFFLINE_AFTER_MS = 15_000

export function useLiveState(): { snapshot: Snapshot | null; connection: Connection } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [connection, setConnection] = useState<Connection>('connecting')
  useEffect(() => {
    const events = new EventSource('/api/events')
    let offline: ReturnType<typeof setTimeout> | null = null
    const clearOffline = () => {
      if (offline) clearTimeout(offline)
      offline = null
    }
    events.addEventListener('state', event => {
      clearOffline()
      setConnection('live')
      setSnapshot(JSON.parse((event as MessageEvent<string>).data) as Snapshot)
    })
    events.addEventListener('error', () => {
      setConnection(current => (current === 'offline' ? current : 'reconnecting'))
      offline ??= setTimeout(() => setConnection('offline'), OFFLINE_AFTER_MS)
    })
    return () => {
      clearOffline()
      events.close()
    }
  }, [])
  return { snapshot, connection }
}
