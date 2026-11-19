import { ArrowLeft, Square, X } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'

import type { Integration, Task, Turn, Worker, WorkerActivity } from '@contracts/api'
import { engineName } from '@/components/engine-icon'
import { Markdown } from '@/components/markdown'
import { WorkerIcon } from '@/components/worker-icon'
import { api } from '@/lib/api'
import { fileChanges, patchLines } from '@/lib/diff'
import { clockTime, elapsed, folderName } from '@/lib/format'
import type { Selection } from '@/lib/selection'
import { latestWorker, rowTone, STAGE_LABELS, STATUS_LABELS, taskStage } from '@/lib/status'
import {
  errorText,
  field,
  fieldLabel,
  ghost,
  linkButton,
  meta,
  mono,
  outlineButton,
  row,
  rowAside,
  rowLabel,
  rows,
  working,
} from '@/lib/styles'
import { useFetched } from '@/lib/use-fetched'
import { cn } from '@/lib/utils'

const CHANGES_REFRESH_MS = 15_000
const ACTIVITY_REFRESH_MS = 10_000
const SUBTITLE = 'flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground'
const BODY = 'flex flex-1 flex-col gap-4 overflow-auto px-4 py-3.5'
const PATCH_LINE = { add: 'text-added', del: 'text-removed', hunk: 'text-faint', context: undefined }

type InspectorProps = {
  revision: number
  offline: boolean
  onSelect: (selection: Selection) => void
  onBack: () => void
  onClose: () => void
  onError: (message: string) => void
}

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

function ActivityLines({ worker, activity, className }: { worker: Worker; activity: WorkerActivity | null; className?: string }) {
  if (!activity) return null
  const step = worker.status === 'running' ? activity.step : null
  const count = activity.changedFiles.length
  if (!step && !count) return null
  return (
    <span className={cn(meta, 'min-w-0 flex-col items-stretch gap-0.5', className)}>
      {step && (
        <span className="truncate" title={`${step.text} · ${clockTime(step.at)}`}>
          Now: <span className="text-foreground">{step.text}</span>
        </span>
      )}
      {count > 0 && (
        <span className="truncate" title={activity.changedFiles.join('\n')}>
          {count === 1 ? '1 file changed' : `${count} files changed`}
        </span>
      )}
    </span>
  )
}

function useActivity(worker: Worker): WorkerActivity | null {
  const running = worker.status === 'running'
  const { data } = useFetched(
    signal => api.activity(worker.id, signal),
    [worker.id, worker.status, worker.turnCount],
    running ? ACTIVITY_REFRESH_MS : null,
  )
  return data
}

function modelLine(worker: Worker): string {
  return [engineName(worker.engine), worker.model, worker.effort].filter(Boolean).join(' · ')
}

function timing(worker: Worker): string {
  const started = `Started ${clockTime(worker.createdAt)}`
  if (worker.status !== 'running') return started
  const turn = worker.turnCount > 1 ? `turn ${worker.turnCount} running` : 'running'
  return `${started} · ${turn} ${elapsed(worker.turnStartedAt, null)}`
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

export function WorkerInspector({ id, ...props }: InspectorProps & { id: string }) {
  const { data, error } = useFetched(signal => api.worker(id, signal), [id, props.revision])
  const [tab, setTab] = useState<'turns' | 'changes'>('turns')
  if (!data || data.worker.id !== id) return <Placeholder error={error} {...props} />
  const { worker, turns } = data
  return (
    <>
      <Head title={worker.title} {...props}>
        <div className={SUBTITLE}>
          <WorkerIcon engine={worker.engine} running={worker.status === 'running'} small />
          <span>{modelLine(worker)}</span>
        </div>
        <WorkerActivityLines worker={worker} />
        <div className={meta}>
          <span className={cn(worker.status === 'failed' && 'text-destructive')}>{STATUS_LABELS[worker.status]}</span>
          <span title={worker.createdAt}>{timing(worker)}</span>
          {worker.repo && <span className={mono}>{worker.repo.branch}</span>}
          {worker.taskId && (
            <button className={linkButton} type="button" onClick={() => props.onSelect({ kind: 'task', id: worker.taskId as string })}>
              Open task
            </button>
          )}
        </div>
      </Head>
      <div className="flex gap-0.5 border-b px-2.5" role="tablist" aria-label="Worker detail">
        {(['turns', 'changes'] as const).map(name => (
          <button
            key={name}
            className={cn(
              ghost,
              'rounded-none border-b-2 border-transparent p-2 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground',
              tab === name && 'border-foreground text-foreground',
            )}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
          >
            {name === 'turns' ? 'Turns' : 'Changes'}
          </button>
        ))}
      </div>
      <div className={BODY}>
        {tab === 'turns' ? (
          [...turns].reverse().map(turn => <TurnView key={turn.number} turn={turn} worker={worker} />)
        ) : (
          <Changes worker={worker} offline={props.offline} />
        )}
      </div>
      <WorkerActions worker={worker} offline={props.offline} onError={props.onError} />
    </>
  )
}

function WorkerActivityLines({ worker }: { worker: Worker }) {
  return <ActivityLines worker={worker} activity={useActivity(worker)} />
}

function TurnView({ turn, worker }: { turn: Turn; worker: Worker }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-2xs text-faint">
        Turn {turn.number}
        {turn.model ? ` · ${turn.model}` : ''} · {clockTime(turn.startedAt)}
      </div>
      <div className={fieldLabel}>Moxy asked</div>
      <div className="border-l-2 py-0.5 pl-2.5 whitespace-pre-wrap wrap-anywhere text-muted-foreground">{turn.input}</div>
      <div className={fieldLabel}>Worker said</div>
      {turn.output && <Markdown text={turn.output} />}
      {turn.status === 'running' && (
        <div className={working}>
          <WorkerIcon engine={worker.engine} running small />
          <span>Still working</span>
        </div>
      )}
      {turn.error && <div className={cn(errorText, turn.status !== 'failed' && 'text-faint')}>{turn.error}</div>}
      {!turn.output && !turn.error && turn.status !== 'running' && <div className="text-faint">{STATUS_LABELS[turn.status]}</div>}
    </div>
  )
}

function Changes({ worker, offline }: { worker: Worker; offline: boolean }) {
  const running = worker.status === 'running'
  const { data, error, reload } = useFetched(
    signal => api.changes(worker.id, signal),
    [worker.id, worker.status],
    running ? CHANGES_REFRESH_MS : null,
  )
  if (!worker.repo) return <div className="text-faint">This worker runs in a folder, not a worktree, so there is no diff.</div>
  const diff = data?.diff
  const files = diff ? fileChanges(diff.patch) : []
  return (
    <>
      <div className={meta}>
        {data && <span>Fetched {clockTime(data.fetchedAt)}</span>}
        <button className={outlineButton} type="button" disabled={offline} onClick={reload}>
          Refresh
        </button>
        {running && <span>Refreshes every 15 s while it runs</span>}
      </div>
      {error && <div className={errorText}>{error}</div>}
      {diff && (files.length || diff.untrackedFiles.length) ? (
        <>
          <div className="flex flex-col gap-0.75 font-mono text-xs">
            {files.map(file => (
              <div key={file.name} className="flex gap-2">
                <span className="min-w-0 flex-1 truncate" title={file.name}>
                  {file.name}
                </span>
                <span className="text-added">+{file.added}</span>
                <span className="text-removed">−{file.removed}</span>
              </div>
            ))}
            {diff.untrackedFiles.map(file => (
              <div key={file} className="flex gap-2">
                <span className="min-w-0 flex-1 truncate" title={file}>
                  {file}
                </span>
                <span className="text-faint">new</span>
              </div>
            ))}
          </div>
          {diff.patch && (
            <div className="overflow-auto rounded-md border bg-background px-2.5 py-2 font-mono text-2xs leading-[1.55] whitespace-pre">
              {patchLines(diff.patch).map((line, index) => (
                <div key={index} className={PATCH_LINE[line.kind]}>
                  {line.text || ' '}
                </div>
              ))}
            </div>
          )}
          {diff.truncated && <div className="text-faint">The diff is too long to show in full.</div>}
        </>
      ) : (
        data && <div className="text-faint">No changes against where it started.</div>
      )}
    </>
  )
}

const ACTIONS = 'flex items-center gap-2 border-t px-4 py-2.5'

function WorkerActions({ worker, offline, onError }: { worker: Worker; offline: boolean; onError: (message: string) => void }) {
  const [text, setText] = useState('')
  const fail = (error: unknown) => onError(error instanceof Error ? error.message : String(error))
  if (worker.status === 'running')
    return (
      <div className={ACTIONS}>
        <button className={outlineButton} type="button" disabled={offline} onClick={() => void api.stopWorker(worker.id).catch(fail)}>
          <Square className="size-3" />
          Stop
        </button>
        <span className="text-xs text-faint">Next turn: {modelLine(worker)}</span>
      </div>
    )
  const send = () => {
    if (!text.trim()) return
    void api
      .messageWorker(worker.id, text.trim())
      .then(() => setText(''))
      .catch(fail)
  }
  return (
    <form
      className={ACTIONS}
      onSubmit={event => {
        event.preventDefault()
        send()
      }}
    >
      <label className="sr-only" htmlFor="worker-message">
        Message this worker
      </label>
      <input
        id="worker-message"
        className={cn(field, 'flex-1 px-2.5 py-1.25')}
        placeholder="Message this worker"
        value={text}
        disabled={offline}
        onChange={event => setText(event.target.value)}
      />
      <button className={outlineButton} type="submit" disabled={offline || !text.trim()}>
        Send
      </button>
    </form>
  )
}

function Head({ title, children, onBack, onClose }: { title: string; children?: ReactNode } & Pick<InspectorProps, 'onBack' | 'onClose'>) {
  return (
    <div className="flex flex-col gap-1 border-b py-3 pr-3.5 pl-4">
      <div className="flex items-start gap-1.5">
        <button className={cn(ghost, 'md:hidden')} type="button" aria-label="Back" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </button>
        <span className="min-w-0 flex-1 pt-0.75 text-[15px] leading-[1.35] font-semibold">{title}</span>
        <button className={cn(ghost, 'max-md:hidden')} type="button" aria-label="Close inspector" onClick={onClose}>
          <X className="size-4" />
        </button>
      </div>
      {children}
    </div>
  )
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

function Placeholder({ error, ...props }: InspectorProps & { error: string | null }) {
  return (
    <>
      <Head title="" {...props} />
      <div className={BODY}>{error ? <div className={errorText}>{error}</div> : <div className="text-faint">Loading…</div>}</div>
    </>
  )
}
