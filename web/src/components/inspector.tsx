import type { ReactNode } from 'react'

import type { Integration, Task, Worker } from '@contracts/api'
import { Markdown } from '@/components/markdown'
import { WorkerIcon } from '@/components/worker-icon'
import { api } from '@/lib/api'
import { clockTime, folderName } from '@/lib/format'
import { latestWorker, rowTone, STAGE_LABELS, STATUS_LABELS, taskStage } from '@/lib/status'
import { fieldLabel, meta, mono, row, rowAside, rowLabel, rows } from '@/lib/styles'
import { useFetched } from '@/lib/use-fetched'
import { cn } from '@/lib/utils'
import { ActivityLines, BODY, Head, modelLine, Placeholder, SUBTITLE, timing, useActivity } from './inspector-shared'
import type { InspectorProps } from './inspector-shared'

export { WorkerInspector } from './inspector-worker'

export function TaskInspector({ id, ...props }: InspectorProps & { id: string }) {
  const { data, error } = useFetched(signal => api.task(id, signal), [id, props.revision])
  if (!data || data.task.id !== id) return <Placeholder error={error} {...props} />
  const { task, workers, integrations } = data
  const latest = latestWorker(workers)
  const stage = taskStage(task, workers)
  return (
    <>
      <Head title={task.title} {...props}>
        <div className={SUBTITLE}>
          <WorkerIcon engine={latest?.engine ?? null} running={stage !== 'done'} small />
          <span>{STAGE_LABELS[stage]}</span>
          {task.repoRoot && (
            <>
              <span aria-hidden="true">·</span>
              <span className={mono} title={task.repoRoot}>
                {folderName(task.repoRoot)}
              </span>
            </>
          )}
        </div>
      </Head>
      <div className={BODY}>
        {task.howToTry && <Delivery task={task} />}
        <Field label="Plan" text={task.plan} />
        <Field label="Notes" text={task.notes} />
        <Field label="Testing" text={task.testing} />
        <div>
          <div className={fieldLabel}>Workers</div>
          {workers.length ? (
            <div className={rows}>
              {workers.map(worker => (
                <WorkerSummary key={worker.id} worker={worker} onOpen={() => props.onSelect({ kind: 'worker', id: worker.id })} />
              ))}
            </div>
          ) : (
            <div className="text-faint">No workers.</div>
          )}
        </div>
        {integrations.length > 0 && <Integrations integrations={integrations} />}
      </div>
    </>
  )
}

function WorkerSummary({ worker, onOpen }: { worker: Worker; onOpen: () => void }) {
  const activity = useActivity(worker)
  return (
    <button
      className={cn(row(rowTone(worker.status)), 'flex-col items-stretch gap-0.5')}
      type="button"
      title={`${worker.title} · ${STATUS_LABELS[worker.status]}`}
      onClick={onOpen}
    >
      <span className="flex min-w-0 items-center gap-2">
        <WorkerIcon engine={worker.engine} running={worker.status === 'running'} />
        <span className={rowLabel}>{worker.title}</span>
        <span className={rowAside}>{STATUS_LABELS[worker.status]}</span>
      </span>
      <span className={cn(meta, 'pl-6')}>
        <span>{modelLine(worker)}</span>
        <span>{timing(worker)}</span>
      </span>
      <ActivityLines worker={worker} activity={activity} className="pl-6" />
    </button>
  )
}

function Delivery({ task }: { task: Task }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border bg-background px-3 py-2.5">
      <div className={fieldLabel}>How to try it</div>
      <Markdown text={task.howToTry ?? ''} />
      {(task.revision || task.supersededBy) && (
        <div className={meta}>
          {task.revision && <span className={mono}>{task.revision.slice(0, 7)}</span>}
          {task.supersededBy && (
            <span title={`A later task changed the same repository at ${task.supersededBy}`}>Includes later changes</span>
          )}
        </div>
      )}
    </div>
  )
}

function Integrations({ integrations }: { integrations: Integration[] }) {
  return (
    <div>
      <div className={fieldLabel}>Integrations</div>
      <div className="flex flex-col gap-1.5 text-xs">
        {[...integrations].reverse().map(integration => (
          <div key={integration.id} className="flex items-baseline gap-2">
            <span className="flex-none text-faint tabular-nums">{clockTime(integration.startedAt)}</span>
            <span className={cn((integration.status === 'refused' || integration.status === 'interrupted') && 'text-destructive')}>
              {integrationText(integration)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function integrationText(integration: Integration): ReactNode {
  const into = folderName(integration.repoRoot)
  if (integration.status === 'merged')
    return (
      <>
        Merged {integration.branch} into {into} at <span className={mono}>{integration.revision?.slice(0, 7)}</span>
      </>
    )
  if (integration.status === 'running') return `Merging ${integration.branch} into ${into}`
  return `${integration.status === 'refused' ? 'Refused' : 'Interrupted'}: ${integration.error ?? 'no reason given'}`
}

function Field({ label, text }: { label: string; text: string }) {
  if (!text.trim()) return null
  return (
    <div>
      <div className={fieldLabel}>{label}</div>
      <Markdown text={text} />
    </div>
  )
}
