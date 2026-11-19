import type { ReactNode } from 'react'

import type { Task, Worker } from '@contracts/api'
import { WorkerIcon } from '@/components/worker-icon'
import { useStoredFlag } from '@/lib/stored'
import { latestWorker, rowTone, STAGE_LABELS, STATUS_LABELS, taskStage, workersByTask } from '@/lib/status'
import type { TaskStage } from '@/lib/status'
import type { Selection } from '@/lib/selection'
import { cn } from '@/lib/utils'

const STAGES: TaskStage[] = ['working', 'reviewing', 'done']

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
      {STAGES.map(stage => {
        const rows = tasks.filter(task => taskStage(task, byTask.get(task.id) ?? []) === stage)
        return (
          <Section key={stage} id={stage} label={STAGE_LABELS[stage]} count={rows.length}>
            {rows.map(task => {
              const latest = latestWorker(byTask.get(task.id) ?? [])
              return (
                <Row
                  key={task.id}
                  label={task.title}
                  tip={`${task.title} · ${STAGE_LABELS[stage]}`}
                  icon={<WorkerIcon engine={latest?.engine ?? null} running={stage !== 'done'} />}
                  tone={stage === 'reviewing' && latest ? rowTone(latest.status) : ''}
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

function Section({ id, label, count, children }: { id: string; label: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useStoredFlag(`section:${id}`, true)
  return (
    <div>
      <button className="ghost section-head" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{label}</span>
        <span className="count">{count}</span>
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
