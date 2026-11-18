import { useEffect, useRef, useState } from 'preact/hooks'

import { api } from './api.js'
import { ErrorBanner, StatusDot } from './components/common.js'
import { ConfirmDialog, SettingsDialog, StartDialog, WorktreesDialog } from './components/dialogs.js'
import { Navigation, NeedsAttention, QuotaStrip } from './components/navigation.js'
import { ChatWorkspace, RunWorkspace } from './components/workspace.js'
import { chatHref, runHref, useLiveState, useRoute } from './state.js'
import type { ChatSummary, Route, RunSummary } from './types.js'

type Overlay =
  | { kind: 'chat' | 'worker' }
  | { kind: 'worktrees' | 'settings' | 'stop-all' }
  | { kind: 'retry'; run: RunSummary }
  | { kind: 'stop-run'; run: RunSummary }
  | { kind: 'stop-chat'; chat: ChatSummary }

export function App() {
  const { data, connection, error } = useLiveState()
  const route = useRoute()
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [notice, setNotice] = useState('')
  const [now, setNow] = useState(Date.now)
  const [wide, setWide] = useState(() => matchMedia('(min-width: 761px)').matches)
  const [continueRun, setContinueRun] = useState<{ id: string; count: number }>()
  const workspace = useRef<HTMLElement>(null)
  const sidebar = useRef<HTMLElement>(null)
  const offline = connection === 'offline' || data?.principal.online === false
  const disabled = offline || !data
  const defaultChat = data?.chats[0]
  const active: Route = route.kind === 'home' && wide && defaultChat ? { kind: 'chat', id: defaultChat.id } : route
  const activeId = active.kind === 'home' ? null : active.id
  const autoFocusRun = route.kind === 'run' && route.id === continueRun?.id ? continueRun.count : undefined

  useEffect(() => {
    const query = matchMedia('(min-width: 761px)')
    const resize = (event: MediaQueryListEvent) => setWide(event.matches)
    query.addEventListener('change', resize)
    return () => query.removeEventListener('change', resize)
  }, [])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 7000)
    return () => window.clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    if (route.kind !== 'home' && autoFocusRun === undefined) workspace.current?.focus()
  }, [route.kind, activeId])

  function close() {
    setOverlay(null)
  }
  function startChat() {
    setOverlay({ kind: 'chat' })
  }
  function startWorker() {
    setOverlay({ kind: 'worker' })
  }
  function retry(run: RunSummary) {
    setOverlay({ kind: 'retry', run })
  }
  function proceed(run: RunSummary) {
    setContinueRun(previous => ({ id: run.id, count: (previous?.count ?? 0) + 1 }))
    location.hash = runHref(run.id)
  }
  function started(kind: 'chat' | 'run', id: string, note?: string) {
    close()
    if (note) setNotice(note)
    location.hash = kind === 'chat' ? chatHref(id) : runHref(id)
  }

  const attention = (chatId?: string, compact = false) =>
    data && <NeedsAttention state={data} now={now} proceed={proceed} retry={retry} offline={offline} chatId={chatId} compact={compact} />
  const lastClawEvent = data?.claw.history?.at(-1)
  const hostState = offline ? 'offline' : connection
  return (
    <div class="app-shell" data-view={route.kind}>
      <a
        href="#workspace"
        class="skip-link"
        onClick={event => {
          event.preventDefault()
          const target = workspace.current?.getClientRects().length ? workspace.current : sidebar.current
          target?.focus()
        }}
      >
        Skip to content
      </a>
      <header class="topbar">
        <div class="topbar-left">
          <a class="brand" href="#/">
            <img src="/icon.svg" alt="" width="31" height="31" />
            <span>Grip</span>
          </a>
          <span class="host-status" title={hostState} aria-label={`${data?.principal.host ?? 'Principal'} ${hostState}`}>
            <StatusDot status={hostState} />
            <span>{data?.principal.host ?? (offline ? 'Offline' : 'Connecting')}</span>
          </span>
        </div>
        <div class="topbar-actions">
          <button class="button button-secondary" type="button" onClick={() => setOverlay({ kind: 'worktrees' })}>
            Worktrees
          </button>
          <button class="button button-danger" type="button" disabled={disabled} onClick={() => setOverlay({ kind: 'stop-all' })}>
            Stop all
          </button>
          <button class="icon-button" type="button" aria-label="Settings" title="Settings" onClick={() => setOverlay({ kind: 'settings' })}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M10 3h4l.7 2.7 2 .9 2.5-1.4 2 3.4-2 1.9v2.9l2 1.9-2 3.4-2.5-1.4-2 .9L14 21h-4l-.7-2.7-2-.9-2.5 1.4-2-3.4 2-1.9v-2.9l-2-1.9 2-3.4 2.5 1.4 2-.9L10 3Z" />
            </svg>
          </button>
        </div>
      </header>
      {offline && (
        <div class="connection-banner" role="status">
          <span>Grip is disconnected. Reconnecting…</span>
          {data && <span>Showing the last update</span>}
        </div>
      )}
      <ErrorBanner text={error} />
      {lastClawEvent?.kind === 'rolled-back' && (
        <p class="connection-banner claw-rollback">
          Claw rolled back{lastClawEvent.to ? ` to ${lastClawEvent.to}` : ''}.
          <button class="quiet-button" type="button" onClick={() => setOverlay({ kind: 'settings' })}>
            Update history
          </button>
        </p>
      )}
      <div class="app-body">
        <aside class="sidebar" aria-label="Chat list" tabIndex={-1} ref={sidebar}>
          {data ? (
            <>
              <div class="sidebar-scroll">
                <div class="mobile-attention">{attention()}</div>
                <Navigation state={data} active={active} now={now} offline={offline} newChat={startChat} newWorker={startWorker} />
              </div>
              <footer class="nav-footer">
                <QuotaStrip snapshot={data.quota} now={now} offline={offline} />
              </footer>
            </>
          ) : (
            <div class="sidebar-header">
              <h2>Chats</h2>
              {!error && (
                <span class="muted" role="status">
                  Loading…
                </span>
              )}
            </div>
          )}
        </aside>
        <main class="workspace" id="workspace" ref={workspace} tabIndex={-1}>
          <div class="workspace-attention">{attention(route.kind === 'chat' ? route.id : undefined, active.kind === 'run')}</div>
          {active.kind === 'chat' ? (
            <ChatWorkspace
              key={active.id}
              id={active.id}
              live={data?.chats.find(chat => chat.id === active.id)}
              now={now}
              offline={offline}
              attention={attention(active.id, true)}
              stop={chat => setOverlay({ kind: 'stop-chat', chat })}
            />
          ) : active.kind === 'run' ? (
            <RunWorkspace
              key={active.id}
              id={active.id}
              live={data?.runs.find(run => run.id === active.id)}
              state={data}
              now={now}
              offline={offline}
              focus={autoFocusRun}
              retry={retry}
              stop={run => setOverlay({ kind: 'stop-run', run })}
            />
          ) : !data ? (
            <div class="loading-workspace" role="status" aria-label={error ? 'Workspace unavailable' : 'Loading workspace'}>
              <div class="loading-header">
                <span />
                <span />
              </div>
              <div class="loading-thread">
                <span />
                <span />
                <span />
              </div>
              {error && <p class="workspace-status">Grip could not load this workspace.</p>}
            </div>
          ) : (
            <div class="empty-state">
              <h1>Chats and workers</h1>
              <p>
                {data
                  ? 'Start a conversation with Claude or send a task to one worker.'
                  : error
                    ? 'Grip could not load this workspace.'
                    : 'Connecting to the principal…'}
              </p>
              {data && (
                <div class="button-row">
                  <button class="button button-primary" type="button" disabled={offline} onClick={startChat}>
                    Start a chat
                  </button>
                  <button class="button button-secondary" type="button" disabled={offline} onClick={startWorker}>
                    Start one worker
                  </button>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
      {notice && (
        <div class="toast" role="status">
          {notice}
        </div>
      )}
      {(overlay?.kind === 'chat' || overlay?.kind === 'worker' || overlay?.kind === 'retry') && (
        <StartDialog mode={overlay} state={data} offline={disabled} close={close} started={started} />
      )}
      {overlay?.kind === 'worktrees' && <WorktreesDialog offline={offline} close={close} />}
      {overlay?.kind === 'settings' && <SettingsDialog state={data} close={close} />}
      {overlay?.kind === 'stop-all' && (
        <ConfirmDialog
          title="Stop all work?"
          description={`This stops every active chat and worker on ${data?.principal.host ?? 'the principal'}. Worktrees and messages stay.`}
          label="Stop all work"
          offline={disabled}
          close={close}
          confirm={async () => {
            const result = await api.stopAll()
            const count = result.stopped.length + result.stoppedChats.length
            setNotice(count ? `Stopped ${count} ${count === 1 ? 'chat or worker' : 'chats and workers'}.` : 'No work was running.')
          }}
        />
      )}
      {overlay?.kind === 'stop-chat' && (
        <ConfirmDialog
          title="Stop this chat?"
          description={`This stops ${overlay.chat.title} and its active workers. Worktrees and messages stay.`}
          label="Stop chat"
          offline={offline}
          close={close}
          confirm={async () => {
            await api.stopChat(overlay.chat.id)
            setNotice('Chat stopped.')
          }}
        />
      )}
      {overlay?.kind === 'stop-run' && (
        <ConfirmDialog
          title="Stop this worker?"
          description={`This ends the current turn for ${overlay.run.title}. Its worktree and messages stay.`}
          label="Stop worker"
          offline={offline}
          close={close}
          confirm={async () => {
            await api.stopRun(overlay.run.id)
            setNotice('Worker stopped.')
          }}
        />
      )}
    </div>
  )
}
