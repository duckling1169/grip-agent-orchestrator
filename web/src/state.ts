import { useEffect, useLayoutEffect, useState } from 'react'

import { api, errorText } from './api.js'
import { apiUrl } from './machine.js'
import type { AppState, ChatRecord, ClawState, QuotaSnapshot, Route, RunSummary } from './types.js'

export function parseRoute(hash: string): Route {
  const match = /^#\/(chats|runs)\/([\w-]+)\/?$/.exec(hash)
  if (!match?.[2]) return { kind: 'home' }
  return { kind: match[1] === 'chats' ? 'chat' : 'run', id: match[2] }
}

export const chatHref = (id: string) => `#/chats/${encodeURIComponent(id)}`
export const runHref = (id: string) => `#/runs/${encodeURIComponent(id)}`

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash))
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return route
}

type Event =
  | { kind: 'state'; value: AppState }
  | { kind: 'chat'; value: ChatRecord }
  | { kind: 'chat-deleted'; value: { id: string } }
  | { kind: 'run'; value: RunSummary }
  | { kind: 'quota'; value: QuotaSnapshot }
  | { kind: 'claw'; value: ClawState }

function upsert<T extends { id: string }>(items: T[], entry: T): T[] {
  return items.some(item => item.id === entry.id) ? items.map(item => (item.id === entry.id ? entry : item)) : [entry, ...items]
}

export function reconcile(state: AppState | null, event: Event): AppState | null {
  if (event.kind === 'state') return event.value
  if (!state) return null
  switch (event.kind) {
    case 'quota':
      return { ...state, quota: event.value }
    case 'claw':
      return { ...state, claw: event.value }
    case 'chat': {
      const chat = event.value
      return { ...state, chats: upsert(state.chats, { ...chat, runs: state.runs.filter(run => run.chatId === chat.id) }) }
    }
    case 'chat-deleted': {
      const { id } = event.value
      return { ...state, chats: state.chats.filter(chat => chat.id !== id), runs: state.runs.filter(run => run.chatId !== id) }
    }
    case 'run': {
      const run = event.value
      return {
        ...state,
        runs: upsert(state.runs, run),
        chats: state.chats.map(chat => (chat.id === run.chatId ? { ...chat, runs: upsert(chat.runs, run) } : chat)),
      }
    }
  }
}

/** The live state of the Grip at `base` (null: the machine that served the page). */
export function useLiveState(base: string | null) {
  const [data, setData] = useState<AppState | null>(null)
  const [connection, setConnection] = useState<'connecting' | 'online' | 'offline'>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [showOfflineBanner, setShowOfflineBanner] = useState(false)
  const offline = connection === 'offline' || data?.principal.online === false

  useEffect(() => {
    const controller = new AbortController()
    let stream: EventSource
    let retry: number | undefined
    let receivedSnapshot = false

    function clearRetry() {
      window.clearTimeout(retry)
      retry = undefined
    }

    function openStream() {
      const current = new EventSource(apiUrl('/api/events', base))
      const isCurrent = () => stream === current && !controller.signal.aborted
      current.onopen = () => {
        if (!isCurrent()) return
        clearRetry()
        setConnection('online')
      }
      current.onerror = () => {
        if (!isCurrent()) return
        setConnection('offline')
        if (document.visibilityState === 'visible' && retry === undefined) {
          retry = window.setTimeout(() => {
            retry = undefined
            if (document.visibilityState === 'visible') reconnect()
          }, 1_000)
        }
      }
      for (const kind of ['state', 'run', 'chat', 'chat-deleted', 'quota', 'claw'] as const) {
        current.addEventListener(kind, event => {
          if (!isCurrent()) return
          try {
            const value = JSON.parse((event as MessageEvent<string>).data)
            if (kind === 'state') {
              receivedSnapshot = true
              setError(null)
            }
            setData(previous => reconcile(previous, { kind, value }))
          } catch {
            setError('Grip sent an unreadable update.')
          }
        })
      }
      return current
    }

    function reconnect() {
      clearRetry()
      if (stream.readyState === EventSource.OPEN) {
        if (navigator.onLine) setConnection('online')
        return
      }
      stream.close()
      stream = openStream()
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'visible') reconnect()
    }

    const onOffline = () => setConnection('offline')
    stream = openStream()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('online', reconnect)
    window.addEventListener('offline', onOffline)
    if (!navigator.onLine) onOffline()

    // Give the stream's initial snapshot a moment to arrive before making a fallback GET.
    // Racing both from the outset needlessly mounts and cancels selected-detail requests twice.
    const fallback = window.setTimeout(() => {
      if (receivedSnapshot) return
      void api.state(controller.signal).then(
        value => {
          if (!controller.signal.aborted && !receivedSnapshot) setData(value)
        },
        error => {
          if (!controller.signal.aborted && !receivedSnapshot) setError(errorText(error))
        },
      )
    }, 400)
    return () => {
      window.clearTimeout(fallback)
      clearRetry()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('online', reconnect)
      window.removeEventListener('offline', onOffline)
      controller.abort()
      stream.close()
    }
  }, [base])

  useEffect(() => {
    if (!offline) {
      setShowOfflineBanner(false)
      return
    }
    const timeout = window.setTimeout(() => setShowOfflineBanner(true), 2_000)
    return () => window.clearTimeout(timeout)
  }, [offline])

  return { data, connection, error, showOfflineBanner: offline && showOfflineBanner }
}

/** Keep the last detail on a live refresh and never render a reply for a different selection. */
export function useDetail<T>(key: string, read: (key: string, signal: AbortSignal) => Promise<T>, revision?: unknown) {
  const [response, setResponse] = useState<{ key: string; data: T | null; error?: string }>()
  const [generation, setGeneration] = useState(0)
  useLayoutEffect(() => {
    const controller = new AbortController()
    void read(key, controller.signal).then(
      data => {
        if (!controller.signal.aborted) setResponse({ key, data })
      },
      error => {
        if (!controller.signal.aborted)
          setResponse(previous => ({ key, data: previous?.key === key ? previous.data : null, error: errorText(error) }))
      },
    )
    return () => controller.abort()
  }, [key, read, revision, generation])

  return {
    data: response?.key === key ? response.data : null,
    error: response?.key === key ? response.error : undefined,
    refresh: () => setGeneration(n => n + 1),
  }
}
