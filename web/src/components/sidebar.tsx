import type { ReactNode } from 'react'

import type { Task, Worker } from '@contracts/api'
import { modelFamily, sharedFamily } from '@contracts/engines'
import { WorkerIcon } from '@/components/worker-icon'
import { useStoredFlag } from '@/lib/stored'
import { latestWorker, rowTone, STAGE_LABELS, STATUS_LABELS, taskStage, workersByTask } from '@/lib/status'
import type { RowTone, TaskStage } from '@/lib/status'
import type { Selection } from '@/lib/selection'
import { ghost, row, rowLabel, rows } from '@/lib/styles'
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
  const standaloneWorkers = workers.filter(worker => !worker.taskId)
  return (
    <nav className="flex-1 overflow-auto p-2 max-md:px-2.5" aria-label="Tasks">
      {STAGES.map(stage => {
        const stageTasks = tasks.filter(task => taskStage(task, byTask.get(task.id) ?? []) === stage)
        return (
          <Section key={stage} id={stage} label={STAGE_LABELS[stage]} count={stageTasks.length}>
            {stageTasks.map(task => {
              const taskWorkers = byTask.get(task.id) ?? []
              const latest = latestWorker(taskWorkers)
              return (
                <Row
                  key={task.id}
                  label={task.title}
                  tip={`${task.title} · ${STAGE_LABELS[stage]}`}
                  icon={<WorkerIcon family={sharedFamily(taskWorkers)} running={stage !== 'done'} />}
                  tone={stage === 'reviewing' && latest ? rowTone(latest.status) : null}
                  selected={selection?.kind === 'task' && selection.id === task.id}
                  onOpen={() => onSelect({ kind: 'task', id: task.id })}
                />
              )
            })}
          </Section>
        )
      })}
      {standaloneWorkers.length > 0 && (
        <Section id="standalone-workers" label="Standalone workers" count={standaloneWorkers.length}>
          {standaloneWorkers.map(worker => (
            <Row
              key={worker.id}
              label={worker.title}
              tip={`${worker.title} · ${STATUS_LABELS[worker.status]}`}
              icon={<WorkerIcon family={modelFamily(worker)} running={worker.status === 'running'} />}
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
      <button
        className={cn(ghost, 'w-full px-1.5 py-1 text-2xs font-semibold text-muted-foreground max-md:min-h-11')}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>{label}</span>
        <span className="ml-auto font-medium text-faint tabular-nums">{count}</span>
      </button>
      {open && (count > 0 ? <div className={rows}>{children}</div> : <div className="pr-2 pb-2.5 pl-6.5 text-xs text-faint">None</div>)}
    </div>
  )
}

function Row({
  label,
  tip,
  icon,
  tone,
  selected,
  onOpen,
}: {
  label: string
  tip: string
  icon: ReactNode
  tone: RowTone | null
  selected?: boolean
  onOpen: () => void
}) {
  return (
    <button className={row(tone, selected)} type="button" title={tip} aria-current={selected || undefined} onClick={onOpen}>
      {icon}
      <span className={rowLabel}>{label}</span>
    </button>
  )
}
