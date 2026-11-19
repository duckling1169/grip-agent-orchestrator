import { Gauge, ListTodo, MessageSquare, PanelLeft, PanelRight, Settings as SettingsIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import type { Snapshot } from '@contracts/api'
import { Composer } from '@/components/composer'
import { Conversation } from '@/components/conversation'
import { TaskInspector, WorkerInspector } from '@/components/inspector'
import { ResizeHandle, useColumnWidth } from '@/components/resize-handle'
import type { ColumnWidth } from '@/components/resize-handle'
import { Settings } from '@/components/settings'
import { Quota } from '@/components/quota'
import { Sidebar } from '@/components/sidebar'
import type { Connection } from '@/lib/live'
import { useLiveState } from '@/lib/live'
import type { Selection } from '@/lib/selection'
import { useStoredFlag, useStoredState } from '@/lib/stored'
import { useTheme } from '@/lib/theme'
import { MachineSwitcher } from '@/components/machine-switcher'
import { composerGutter, ghost, readingColumn } from '@/lib/styles'
import { cn } from '@/lib/utils'

export type Side = 'left' | 'right'
type MobileTab = 'moxy' | 'tasks' | 'settings' | 'inspect' | 'quota'

const ERROR_SHOWN_MS = 6000

export function App() {
  const { snapshot, connection } = useLiveState()
  const [linkedTask] = useState(() => {
    const id = new URLSearchParams(window.location.search).get('task')
    return id && /^[\w-]{1,128}$/.test(id) ? id : null
  })
  const theme = useTheme()
  const [side, setSide] = useStoredState<Side>('sidebar-side', stored => (stored === 'right' ? 'right' : 'left'))
  const [sidebarOpen, setSidebarOpen] = useStoredFlag('sidebar-open', true)
  const [inspectorOpen, setInspectorOpen] = useStoredFlag('inspector-open', true)
  const sidebarWidth = useColumnWidth('sidebar', 264, 200, 420)
  const inspectorWidth = useColumnWidth('inspector', 400, 320, 640)
  const [selection, setSelection] = useState<Selection | null>(linkedTask ? { kind: 'task', id: linkedTask } : null)
  const [view, setView] = useState<'conversation' | 'settings'>('conversation')
  const [tab, setTab] = useState<MobileTab>(linkedTask ? 'inspect' : 'moxy')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (linkedTask) setInspectorOpen(true)
  }, [linkedTask])

  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(null), ERROR_SHOWN_MS)
    return () => clearTimeout(timer)
  }, [error])

  if (!snapshot) return <Splash connection={connection} />

  const offline = connection === 'offline'
  const running = snapshot.conversation.some(entry => entry.type === 'moxy' && entry.turn.status === 'running')
  const inspecting = selection !== null && inspectorOpen
  const select = (next: Selection) => {
    setSelection(next)
    setInspectorOpen(true)
    setTab('inspect')
  }
  const back = () => {
    const worker = selection?.kind === 'worker' ? snapshot.workers.find(item => item.id === selection.id) : undefined
    if (worker?.taskId) return setSelection({ kind: 'task', id: worker.taskId })
    setTab('tasks')
  }
  const inspectorProps = {
    revision: snapshot.revision,
    offline,
    onSelect: select,
    onBack: back,
    onClose: () => setInspectorOpen(false),
    onError: setError,
  }

  return (
    <div className="flex h-full flex-col" data-offline={offline || undefined}>
      <Header
        snapshot={snapshot}
        connection={connection}
        side={side}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        inspectorOpen={inspecting}
        canInspect={selection !== null}
        onToggleInspector={() => setInspectorOpen(!inspectorOpen)}
        onSettings={() => setView(view === 'settings' ? 'conversation' : 'settings')}
      />
      <div className={cn('flex min-h-0 flex-1', side === 'right' && 'flex-row-reverse')}>
        <Column
          className={cn(side === 'left' ? 'border-r' : 'border-l', shown(sidebarOpen, tab === 'tasks'))}
          width={sidebarWidth}
          label="Tasks and workers"
        >
          <Sidebar tasks={snapshot.tasks} workers={snapshot.workers} selection={selection} onSelect={select} />
          <div className="max-h-[48%] overflow-auto border-t px-1.5 py-2.5 max-md:hidden">
            <Quota quota={snapshot.quota} offline={offline} onError={setError} />
          </div>
          <ResizeHandle
            column={sidebarWidth}
            edge={side === 'left' ? 'right' : 'left'}
            label="Resize tasks"
            onCollapse={() => setSidebarOpen(false)}
          />
        </Column>
        <main className={cn('min-w-0 flex-1 flex-col bg-background md:min-w-80', shown(view === 'conversation', tab === 'moxy'))}>
          <Conversation entries={snapshot.conversation} offline={offline} onError={setError} />
          {error && (
            <div className={cn(composerGutter, 'pt-1.5')} role="alert">
              <div className={cn(readingColumn, 'text-xs text-destructive')}>{error}</div>
            </div>
          )}
          <Composer leader={snapshot.leader} running={running} offline={offline} onError={setError} />
        </main>
        <section className={cn('min-w-0 flex-1 flex-col overflow-auto px-4 py-4.5', shown(false, tab === 'quota'))} aria-label="Quota">
          <Quota quota={snapshot.quota} offline={offline} onError={setError} />
        </section>
        <Settings
          className={shown(view === 'settings', tab === 'settings')}
          snapshot={snapshot}
          offline={offline}
          theme={theme}
          side={[side, setSide]}
        />
        {selection && (
          <Column
            className={cn(side === 'left' ? 'border-l' : 'border-r', shown(inspectorOpen, tab === 'inspect'))}
            width={inspectorWidth}
            label="Inspector"
          >
            <ResizeHandle
              column={inspectorWidth}
              edge={side === 'left' ? 'left' : 'right'}
              label="Resize inspector"
              onCollapse={() => setInspectorOpen(false)}
            />
            {selection.kind === 'task' ? (
              <TaskInspector id={selection.id} {...inspectorProps} />
            ) : (
              <WorkerInspector id={selection.id} {...inspectorProps} />
            )}
          </Column>
        )}
      </div>
      <nav
        className="grid flex-none grid-cols-4 border-t bg-card pt-1 pb-[max(16px,env(safe-area-inset-bottom))] md:hidden"
        aria-label="Sections"
      >
        <TabButton on={tab === 'moxy'} icon={<MessageSquare />} label="Moxy" onClick={() => setTab('moxy')} />
        <TabButton on={tab === 'tasks' || tab === 'inspect'} icon={<ListTodo />} label="Tasks" onClick={() => setTab('tasks')} />
        <TabButton on={tab === 'quota'} icon={<Gauge />} label="Quota" onClick={() => setTab('quota')} />
        <TabButton on={tab === 'settings'} icon={<SettingsIcon />} label="Settings" onClick={() => setTab('settings')} />
      </nav>
    </div>
  )
}

function Header({
  snapshot,
  connection,
  side,
  sidebarOpen,
  onToggleSidebar,
  inspectorOpen,
  canInspect,
  onToggleInspector,
  onSettings,
}: {
  snapshot: Snapshot
  connection: Connection
  side: Side
  sidebarOpen: boolean
  onToggleSidebar: () => void
  inspectorOpen: boolean
  canInspect: boolean
  onToggleInspector: () => void
  onSettings: () => void
}) {
  const sidebarToggle = (
    <PanelToggle label={sidebarOpen ? 'Hide tasks' : 'Show tasks'} on={sidebarOpen} onClick={onToggleSidebar}>
      {side === 'left' ? <PanelLeft /> : <PanelRight />}
    </PanelToggle>
  )
  const inspectorToggle = (
    <PanelToggle
      label={inspectorOpen ? 'Hide inspector' : 'Show inspector'}
      on={inspectorOpen}
      disabled={!canInspect}
      onClick={onToggleInspector}
    >
      {side === 'left' ? <PanelRight /> : <PanelLeft />}
    </PanelToggle>
  )
  return (
    <header className="flex h-11 flex-none items-center gap-1.5 border-b bg-background px-2.5">
      {side === 'left' && sidebarToggle}
      {side === 'right' && inspectorToggle}
      <span className="pr-1.5 pl-1 text-sm font-semibold tracking-tight">Moxy</span>
      <MachineSwitcher host={snapshot.host} connection={connection} />
      <span className="flex-1" />
      {side === 'left' && inspectorToggle}
      {side === 'right' && sidebarToggle}
      <button className={panelToggle(false)} type="button" aria-label="Settings" title="Settings" onClick={onSettings}>
        <SettingsIcon />
      </button>
    </header>
  )
}

function PanelToggle({
  label,
  on,
  disabled,
  onClick,
  children,
}: {
  label: string
  on: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      className={panelToggle(on)}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function panelToggle(on: boolean): string {
  return cn(ghost, 'p-1.25 text-faint max-md:hidden [&_svg]:size-4', on && 'text-muted-foreground')
}

function shown(desktop: boolean, mobile: boolean): string {
  return cn(desktop ? 'md:flex' : 'md:hidden', mobile ? 'max-md:flex' : 'max-md:hidden')
}

function Column({ className, width, label, children }: { className: string; width: ColumnWidth; label: string; children: ReactNode }) {
  return (
    <aside
      className={cn(
        'relative min-h-0 flex-none flex-col bg-card md:min-w-40 md:flex-[0_1_auto] max-md:static max-md:w-full! max-md:border-0 max-md:bg-background',
        className,
      )}
      style={{ width: width.width }}
      aria-label={label}
    >
      {children}
    </aside>
  )
}

function TabButton({ on, icon, label, onClick }: { on: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      className={cn(
        ghost,
        'min-h-12 flex-col justify-center gap-0.5 rounded-none text-2xs text-faint hover:bg-transparent [&_svg]:size-5',
        on && 'text-foreground',
      )}
      type="button"
      aria-current={on || undefined}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  )
}

function Splash({ connection }: { connection: Connection }) {
  return (
    <div className="grid h-full place-items-center text-sm text-faint">
      {connection === 'offline' ? 'Moxy is not reachable.' : 'Connecting to Moxy…'}
    </div>
  )
}
