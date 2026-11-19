import { ListTodo, MessageSquare, PanelLeft, PanelRight, Settings as SettingsIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import type { Snapshot } from '@contracts/api'
import { Composer } from '@/components/composer'
import { Conversation } from '@/components/conversation'
import { TaskInspector, WorkerInspector } from '@/components/inspector'
import { ResizeHandle, useColumnWidth } from '@/components/resize-handle'
import type { ColumnWidth } from '@/components/resize-handle'
import { Settings } from '@/components/settings'
import { Sidebar } from '@/components/sidebar'
import type { Connection } from '@/lib/live'
import { useLiveState } from '@/lib/live'
import type { Selection } from '@/lib/selection'
import { useStoredFlag, useStoredState } from '@/lib/stored'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'

export type Side = 'left' | 'right'
type MobileTab = 'moxy' | 'tasks' | 'settings' | 'inspect'

const ERROR_SHOWN_MS = 6000

export function App() {
  const { snapshot, connection } = useLiveState()
  const theme = useTheme()
  const [side, setSide] = useStoredState<Side>('sidebar-side', stored => (stored === 'right' ? 'right' : 'left'))
  const [sidebarOpen, setSidebarOpen] = useStoredFlag('sidebar-open', true)
  const [inspectorOpen, setInspectorOpen] = useStoredFlag('inspector-open', true)
  const sidebarWidth = useColumnWidth('sidebar', 264, 200, 420)
  const inspectorWidth = useColumnWidth('inspector', 400, 320, 640)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [view, setView] = useState<'conversation' | 'settings'>('conversation')
  const [tab, setTab] = useState<MobileTab>('moxy')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(null), ERROR_SHOWN_MS)
    return () => clearTimeout(timer)
  }, [error])

  if (!snapshot) return <Splash connection={connection} />

  const offline = connection === 'offline'
  const running = snapshot.conversation.some(entry => entry.type === 'moxy' && entry.turn.status === 'running')
  const waiting = snapshot.tasks.filter(task => task.status === 'waiting').length
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
    <div className={cn('shell', `tab-${tab}`, `view-${view}`, offline && 'offline-mode')}>
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
      <div className={cn('body', side === 'right' && 'right')}>
        <Column className={cn('sidebar', !sidebarOpen && 'collapsed')} width={sidebarWidth} label="Tasks and workers">
          <Sidebar tasks={snapshot.tasks} workers={snapshot.workers} selection={selection} onSelect={select} />
          <ResizeHandle
            column={sidebarWidth}
            edge={side === 'left' ? 'right' : 'left'}
            label="Resize tasks"
            onCollapse={() => setSidebarOpen(false)}
          />
        </Column>
        <main className="main">
          <Conversation entries={snapshot.conversation} offline={offline} onError={setError} />
          {error && (
            <div className="composer pb-0" role="alert">
              <div className="composer-inner note-line fail">{error}</div>
            </div>
          )}
          <Composer leader={snapshot.leader} running={running} offline={offline} onError={setError} />
        </main>
        <Settings snapshot={snapshot} theme={theme} side={[side, setSide]} />
        {selection && (
          <Column className={cn('inspector', !inspectorOpen && 'collapsed')} width={inspectorWidth} label="Inspector">
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
      <nav className="tabbar" aria-label="Sections">
        <TabButton on={tab === 'moxy'} icon={<MessageSquare />} label="Moxy" onClick={() => setTab('moxy')} />
        <TabButton on={tab === 'tasks' || tab === 'inspect'} icon={<ListTodo />} label="Tasks" onClick={() => setTab('tasks')}>
          {waiting > 0 && (
            <span className="badge" aria-label={`${waiting} waiting on you`}>
              {waiting}
            </span>
          )}
        </TabButton>
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
  const machineTip =
    connection === 'offline'
      ? `${snapshot.host} is offline`
      : connection === 'reconnecting'
        ? `Reconnecting to ${snapshot.host}`
        : snapshot.host
  return (
    <header className="header">
      {side === 'left' && sidebarToggle}
      {side === 'right' && inspectorToggle}
      <span className="brand">Moxy</span>
      <span className="ghost machine" title={machineTip} aria-label={machineTip}>
        {(connection === 'reconnecting' || connection === 'offline') && <span className={cn('dot', connection)} aria-hidden="true" />}
        <span>{snapshot.host}</span>
      </span>
      <span className="header-spacer" />
      {side === 'left' && inspectorToggle}
      {side === 'right' && sidebarToggle}
      <button className="ghost panel-toggle header-settings" type="button" aria-label="Settings" title="Settings" onClick={onSettings}>
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
      className={cn('ghost panel-toggle', on && 'on')}
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

function Column({ className, width, label, children }: { className: string; width: ColumnWidth; label: string; children: ReactNode }) {
  return (
    <aside className={className} style={{ width: width.width }} aria-label={label}>
      {children}
    </aside>
  )
}

function TabButton({
  on,
  icon,
  label,
  onClick,
  children,
}: {
  on: boolean
  icon: ReactNode
  label: string
  onClick: () => void
  children?: ReactNode
}) {
  return (
    <button className={cn('ghost tabbtn', on && 'on')} type="button" aria-current={on || undefined} onClick={onClick}>
      {icon}
      {label}
      {children}
    </button>
  )
}

function Splash({ connection }: { connection: Connection }) {
  return (
    <div className="grid h-full place-items-center text-sm text-[var(--faint)]">
      {connection === 'offline' ? 'Moxy is not reachable.' : 'Connecting to Moxy…'}
    </div>
  )
}
