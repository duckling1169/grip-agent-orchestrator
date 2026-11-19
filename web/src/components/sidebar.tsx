import type { ReactNode } from 'react'

import type { Task, Worker } from '@contracts/api'
import { WorkerIcon } from '@/components/worker-icon'
import { useStoredFlag } from '@/lib/stored'
import { latestWorker, rowTone, STATUS_LABELS, TASK_LABELS, workersByTask } from '@/lib/status'
import type { Selection } from '@/lib/selection'
import { cn } from '@/lib/utils'

const SECTIONS = [
  { status: 'waiting', label: 'Waiting on you' },
  { status: 'working', label: 'Working' },
  { status: 'done', label: 'Done' },
] as const

export function Sidebar({
  tasks,
  workers,
  selection,
  onSelect,
}: {
  tasks: Task[]
  workers: Worker[]
  selection: Selection | null
  onSelect: (selection: Selection) => void
}) {
  const byTask = workersByTask(workers)
  const orphans = workers.filter(worker => !worker.taskId)
  return (
    <nav className="sections" aria-label="Tasks">
      {SECTIONS.map(section => {
        const rows = tasks.filter(task => task.status === section.status)
        return (
          <Section
            key={section.status}
            id={section.status}
            label={section.label}
            count={rows.length}
            attention={section.status === 'waiting'}
          >
            {rows.map(task => {
              const taskWorkers = byTask.get(task.id) ?? []
              const latest = latestWorker(taskWorkers)
              const running = taskWorkers.some(worker => worker.status === 'running')
              return (
                <Row
                  key={task.id}
                  label={task.title}
                  tip={`${task.title} · ${TASK_LABELS[task.status]}`}
                  icon={<WorkerIcon engine={latest?.engine ?? null} running={running} />}
                  tone={task.status === 'working' && latest && !running ? rowTone(latest.status) : ''}
                  selected={selection?.kind === 'task' && selection.id === task.id}
                  onOpen={() => onSelect({ kind: 'task', id: task.id })}
                />
              )
            })}
          </Section>
        )
      })}
      {orphans.length > 0 && (
        <Section id="orphans" label="Orphans" count={orphans.length}>
          {orphans.map(worker => (
            <Row
              key={worker.id}
              label={worker.title}
              tip={`${worker.title} · ${STATUS_LABELS[worker.status]}`}
              icon={<WorkerIcon engine={worker.engine} running={worker.status === 'running'} />}
              tone={rowTone(worker.status)}
              selected={selection?.kind === 'worker' && selection.id === worker.id}
              onOpen={() => onSelect({ kind: 'worker', id: worker.id })}
            />
          ))}
        </Section>
      )}
    </nav>
  )
}

function Section({
  id,
  label,
  count,
  attention,
  children,
}: {
  id: string
  label: string
  count: number
  attention?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useStoredFlag(`section:${id}`, true)
  return (
    <div>
      <button className="ghost section-head" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{label}</span>
        <span className={cn('count', attention && count > 0 && 'attention')}>{count}</span>
      </button>
      {open && (count > 0 ? <div className="rows">{children}</div> : <div className="none">None</div>)}
    </div>
  )
}

export function Row({
  label,
  tip,
  icon,
  tone,
  aside,
  selected,
  onOpen,
}: {
  label: string
  tip: string
  icon: ReactNode
  tone: string
  aside?: string
  selected?: boolean
  onOpen: () => void
}) {
  return (
    <button
      className={cn('ghost row', tone, selected && 'selected')}
      type="button"
      title={tip}
      aria-current={selected || undefined}
      onClick={onOpen}
    >
      {icon}
      <span className="label">{label}</span>
      {aside && <span className="aside">{aside}</span>}
    </button>
  )
}
