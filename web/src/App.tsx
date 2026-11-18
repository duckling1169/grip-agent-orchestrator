import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, FolderGit2, RefreshCw, Settings, Square, Wrench } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Toaster } from '@/components/ui/sonner'
import { api, errorText } from './api.js'
import { ErrorBanner, StatusDot } from './components/common.js'
import { ConfirmDialog, SettingsDialog, StartDialog, WorktreesDialog } from './components/dialogs.js'
import { Navigation, NeedsAttention, QuotaStrip } from './components/navigation.js'
import { ChatWorkspace, RunWorkspace } from './components/workspace.js'
import { chatHref, runHref, useLiveState, useRoute } from './state.js'
import type { ChatSummary, Machine, Route, RunSummary } from './types.js'

type Overlay =
  | { kind: 'chat' | 'worker' }
  | { kind: 'worktrees' | 'settings' | 'updates' | 'stop-all' }
  | { kind: 'retry'; run: RunSummary }
  | { kind: 'stop-run'; run: RunSummary }
  | { kind: 'stop-chat'; chat: ChatSummary }

function MachineSwitcher({ host, status }: { host?: string; status: string }) {
  const [machines, setMachines] = useState<Machine[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  return (
    <DropdownMenu
      onOpenChange={open => {
        controller.current?.abort()
        if (!open) return
        const request = new AbortController()
        controller.current = request
        setLoading(true)
        setError('')
        api
          .machines(request.signal)
          .then(
            result => {
              if (!request.signal.aborted) setMachines(result.machines)
            },
            failure => {
              if (!request.signal.aborted) setError(errorText(failure))
            },
          )
          .finally(() => {
            if (!request.signal.aborted) setLoading(false)
          })
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-11 min-w-0 max-w-full gap-2 px-2" aria-label="Switch machine">
          <StatusDot status={status} />
          <span className="truncate">{machines.find(machine => machine.self)?.name ?? host ?? 'Connecting…'}</span>
          <ChevronDown className="size-3.5 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-24px)]">
        <DropdownMenuLabel>Machines</DropdownMenuLabel>
        {loading ? (
          <p role="status" className="px-2 py-3 text-sm text-muted-foreground">
            Loading…
          </p>
        ) : error ? (
          <div className="p-2">
            <ErrorBanner text={error} />
          </div>
        ) : (
          machines.map(machine => {
            const content = (
              <>
                <StatusDot status={machine.online ? 'online' : 'offline'} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{machine.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {machine.ips[0] ?? '—'}
                    {machine.grip !== 'yes' ? ' · Grip not running' : ''}
                  </span>
                </span>
                {machine.self && <Check className="size-4" />}
              </>
            )
            return machine.grip === 'yes' && machine.url && !machine.self ? (
              <DropdownMenuItem key={machine.dnsName} asChild className="min-h-12">
                <a href={machine.url}>{content}</a>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem key={machine.dnsName} disabled={!machine.self} className="min-h-12">
                {content}
              </DropdownMenuItem>
            )
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function App() {
  const { data, connection, error, showOfflineBanner } = useLiveState()
  const route = useRoute()
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [now, setNow] = useState(Date.now)
  const [wide, setWide] = useState(() => matchMedia('(min-width: 768px)').matches)
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
    const query = matchMedia('(min-width: 768px)')
    const resize = (event: MediaQueryListEvent) => setWide(event.matches)
    query.addEventListener('change', resize)
    return () => query.removeEventListener('change', resize)
  }, [])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (route.kind !== 'home' && autoFocusRun === undefined) workspace.current?.focus()
  }, [route.kind, activeId, autoFocusRun])
  const close = () => setOverlay(null)
  const startChat = () => setOverlay({ kind: 'chat' })
  const startWorker = () => setOverlay({ kind: 'worker' })
  const retry = (run: RunSummary) => setOverlay({ kind: 'retry', run })
  function proceed(run: RunSummary) {
    setContinueRun(previous => ({ id: run.id, count: (previous?.count ?? 0) + 1 }))
    location.hash = runHref(run.id)
  }
  function started(kind: 'chat' | 'run', id: string, note?: string) {
    close()
    if (note) toast(note)
    location.hash = kind === 'chat' ? chatHref(id) : runHref(id)
  }
  const attention = (chatId?: string, compact = false) =>
    data && <NeedsAttention state={data} now={now} proceed={proceed} retry={retry} offline={offline} chatId={chatId} compact={compact} />
  const lastClawEvent = data?.claw.history?.at(-1)
  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background font-sans text-foreground antialiased">
      <a
        href="#workspace"
        className="sr-only z-50 rounded-md bg-background p-3 focus:not-sr-only focus:absolute focus:top-3 focus:left-3"
        onClick={event => {
          event.preventDefault()
          ;(workspace.current?.getClientRects().length ? workspace.current : sidebar.current)?.focus()
        }}
      >
        Skip to content
      </a>
      <header className="flex shrink-0 items-center gap-3 border-b px-3 pt-[calc(env(safe-area-inset-top)+12px)] pb-3 md:px-5">
        <a
          href="#/"
          aria-label="Grip home"
          className="flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        >
          <img src="/icon.svg" alt="Grip" width="30" height="30" />
        </a>
        <div className="min-w-0 flex-1">
          <MachineSwitcher host={data?.principal.host} status={offline ? 'offline' : connection} />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-11 shrink-0" aria-label="Settings">
              <Settings className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem className="min-h-11" onSelect={() => setOverlay({ kind: 'worktrees' })}>
              <FolderGit2 />
              Worktrees
            </DropdownMenuItem>
            <DropdownMenuItem className="min-h-11" onSelect={() => setOverlay({ kind: 'updates' })}>
              <RefreshCw />
              Claw updates
            </DropdownMenuItem>
            <DropdownMenuItem className="min-h-11" onSelect={() => setOverlay({ kind: 'settings' })}>
              <Wrench />
              Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              className="min-h-11"
              disabled={disabled}
              onSelect={() => setOverlay({ kind: 'stop-all' })}
            >
              <Square />
              Stop all
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {showOfflineBanner && (
        <p className="shrink-0 border-b px-4 py-2 text-sm text-muted-foreground" role="status">
          Grip is disconnected. Reconnecting…
        </p>
      )}
      <ErrorBanner text={error} />
      {lastClawEvent?.kind === 'rolled-back' && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 text-sm">
          <span>Claw rolled back{lastClawEvent.to ? ` to ${lastClawEvent.to}` : ''}.</span>
          <Button variant="link" onClick={() => setOverlay({ kind: 'updates' })}>
            Update history
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside
          aria-label="Chat list"
          tabIndex={-1}
          ref={sidebar}
          className={`${route.kind === 'home' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col md:flex md:w-88 md:max-w-88 md:flex-none md:border-r`}
        >
          {data ? (
            <>
              <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
                <div className="min-w-0 space-y-3 px-3 py-3">
                  {attention()}
                  <Navigation state={data} active={active} now={now} offline={offline} newChat={startChat} newWorker={startWorker} />
                </div>
              </ScrollArea>
              <footer className="shrink-0 border-t px-3 pt-1 pb-[max(env(safe-area-inset-bottom),12px)]">
                <QuotaStrip snapshot={data.quota} now={now} offline={offline} />
              </footer>
            </>
          ) : (
            <div className="p-4 text-sm text-muted-foreground" role="status">
              {error ? 'Chat list unavailable.' : 'Loading…'}
            </div>
          )}
        </aside>
        <main
          id="workspace"
          ref={workspace}
          tabIndex={-1}
          className={`${route.kind === 'home' ? 'hidden' : 'flex'} min-h-0 min-w-0 flex-1 flex-col md:flex`}
        >
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
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
              <h1 className="text-lg font-semibold">{data ? 'Chats and workers' : 'Connecting…'}</h1>
              {data && (
                <div className="flex flex-wrap gap-2">
                  <Button disabled={offline} onClick={startChat}>
                    Start a chat
                  </Button>
                  <Button variant="outline" disabled={offline} onClick={startWorker}>
                    Start one worker
                  </Button>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
      <Toaster />
      {(overlay?.kind === 'chat' || overlay?.kind === 'worker' || overlay?.kind === 'retry') && (
        <StartDialog mode={overlay} state={data} offline={disabled} close={close} started={started} />
      )}
      {overlay?.kind === 'worktrees' && <WorktreesDialog offline={offline} close={close} />}
      {(overlay?.kind === 'settings' || overlay?.kind === 'updates') && (
        <SettingsDialog state={data} section={overlay.kind === 'updates' ? 'updates' : 'settings'} close={close} />
      )}
      {overlay?.kind === 'stop-all' && (
        <ConfirmDialog
          title="Stop all work?"
          description={`This stops every active chat and worker on ${data?.principal.host ?? 'this machine'}.`}
          label="Stop all"
          offline={disabled}
          close={close}
          confirm={async () => {
            const result = await api.stopAll()
            const count = result.stopped.length + result.stoppedChats.length
            toast(count ? `Stopped ${count} ${count === 1 ? 'chat or worker' : 'chats and workers'}.` : 'No work was running.')
          }}
        />
      )}
      {overlay?.kind === 'stop-chat' && (
        <ConfirmDialog
          title="Stop this chat?"
          description={`This stops ${overlay.chat.title} and its active workers.`}
          label="Stop chat"
          offline={offline}
          close={close}
          confirm={async () => {
            await api.stopChat(overlay.chat.id)
            toast('Chat stopped.')
          }}
        />
      )}
      {overlay?.kind === 'stop-run' && (
        <ConfirmDialog
          title="Stop this worker?"
          description={`This ends the current turn for ${overlay.run.title}.`}
          label="Stop worker"
          offline={offline}
          close={close}
          confirm={async () => {
            await api.stopRun(overlay.run.id)
            toast('Worker stopped.')
          }}
        />
      )}
    </div>
  )
}
