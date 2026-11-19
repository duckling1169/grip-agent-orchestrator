import { ArrowLeft, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import type { Integration, Task, Turn, Worker } from '@contracts/api'
import { engineName } from '@/components/engine-icon'
import { Markdown } from '@/components/markdown'
import { Row } from '@/components/sidebar'
import { WorkerIcon } from '@/components/worker-icon'
import { api } from '@/lib/api'
import { fileChanges, patchLines } from '@/lib/diff'
import { clockTime, elapsed, folderName } from '@/lib/format'
import type { Selection } from '@/lib/selection'
import { latestWorker, rowTone, STAGE_LABELS, STATUS_LABELS, taskStage } from '@/lib/status'
import { useFetched } from '@/lib/use-fetched'
import { cn } from '@/lib/utils'

const CHANGES_REFRESH_MS = 15_000

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
        <div className="insp-sub">
          <WorkerIcon engine={latest?.engine ?? null} running={stage !== 'done'} small />
          <span>{STAGE_LABELS[stage]}</span>
          {task.repoRoot && (
            <>
              <span aria-hidden="true">·</span>
              <span className="mono" title={task.repoRoot}>
                {folderName(task.repoRoot)}
              </span>
            </>
          )}
        </div>
      </Head>
      <div className="insp-body">
        {task.howToTry && <Delivery task={task} />}
        <Field label="Plan" text={task.plan} />
        <Field label="Notes" text={task.notes} />
        <Field label="Testing" text={task.testing} />
        <div>
          <div className="field-label">Workers</div>
          {workers.length ? (
            <div className="rows">
              {workers.map(worker => (
                <Row
                  key={worker.id}
                  label={worker.title}
                  tip={`${worker.title} · ${STATUS_LABELS[worker.status]}`}
                  icon={<WorkerIcon engine={worker.engine} running={worker.status === 'running'} />}
                  tone={rowTone(worker.status)}
                  aside={STATUS_LABELS[worker.status]}
                  onOpen={() => props.onSelect({ kind: 'worker', id: worker.id })}
                />
              ))}
            </div>
          ) : (
            <div className="faint">No workers.</div>
          )}
        </div>
        {integrations.length > 0 && <Integrations integrations={integrations} />}
      </div>
    </>
  )
}

function Delivery({ task }: { task: Task }) {
  return (
    <div className="card">
      <div className="field-label">How to try it</div>
      <Markdown text={task.howToTry ?? ''} />
      {(task.revision || task.supersededBy) && (
        <div className="meta">
          {task.revision && <span className="mono">{task.revision.slice(0, 7)}</span>}
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
      <div className="field-label">Integrations</div>
      <div className="events">
        {[...integrations].reverse().map(integration => (
          <div key={integration.id} className={cn('event', integration.status)}>
            <span className="when">{clockTime(integration.startedAt)}</span>
            <span className="what">{integrationText(integration)}</span>
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
        Merged {integration.branch} into {into} at <span className="mono">{integration.revision?.slice(0, 7)}</span>
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
  const running = worker.status === 'running'
  const modelLine = [engineName(worker.engine), worker.model, worker.effort].filter(Boolean).join(' · ')
  return (
    <>
      <Head title={worker.title} {...props}>
        <div className="insp-sub">
          <WorkerIcon engine={worker.engine} running={running} small />
          <span>{modelLine}</span>
        </div>
        <div className="meta">
          <span className={cn(worker.status === 'failed' && 'status-failed')}>{STATUS_LABELS[worker.status]}</span>
          <span title={worker.createdAt}>Started {elapsed(worker.createdAt, null)} ago</span>
          {worker.repo && <span className="mono">{worker.repo.branch}</span>}
          {worker.taskId && (
            <button className="ghost link" type="button" onClick={() => props.onSelect({ kind: 'task', id: worker.taskId as string })}>
              Open task
            </button>
          )}
        </div>
      </Head>
      <div className="tabs" role="tablist" aria-label="Worker detail">
        {(['turns', 'changes'] as const).map(name => (
          <button
            key={name}
            className={cn('ghost tab', tab === name && 'on')}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
          >
            {name === 'turns' ? 'Turns' : 'Changes'}
          </button>
        ))}
      </div>
      <div className="insp-body">
        {tab === 'turns' ? (
          [...turns].reverse().map(turn => <TurnView key={turn.number} turn={turn} worker={worker} />)
        ) : (
          <Changes worker={worker} offline={props.offline} />
        )}
      </div>
      <WorkerActions worker={worker} modelLine={modelLine} offline={props.offline} onError={props.onError} />
    </>
  )
}

function TurnView({ turn, worker }: { turn: Turn; worker: Worker }) {
  return (
    <div className="turn">
      <div className="turn-head">
        Turn {turn.number}
        {turn.model ? ` · ${turn.model}` : ''} · {clockTime(turn.startedAt)}
      </div>
      <div className="field-label">Moxy asked</div>
      <div className="quote">{turn.input}</div>
      <div className="field-label">Worker said</div>
      {turn.output && <Markdown text={turn.output} />}
      {turn.status === 'running' && (
        <div className="working">
          <WorkerIcon engine={worker.engine} running small />
          <span>Still working</span>
        </div>
      )}
      {turn.error && <div className={cn('error-text', turn.status !== 'failed' && 'quiet')}>{turn.error}</div>}
      {!turn.output && !turn.error && turn.status !== 'running' && <div className="faint">{STATUS_LABELS[turn.status]}</div>}
    </div>
  )
}

function Changes({ worker, offline }: { worker: Worker; offline: boolean }) {
  const running = worker.status === 'running'
  const { data, error, reload } = useFetched(signal => api.changes(worker.id, signal), [worker.id, worker.status])
  useEffect(() => {
    if (!running) return
    const timer = setInterval(reload, CHANGES_REFRESH_MS)
    return () => clearInterval(timer)
  }, [running, reload])
  if (!worker.repo) return <div className="faint">This worker runs in a folder, not a worktree, so there is no diff.</div>
  const diff = data?.diff
  const files = diff ? fileChanges(diff.patch) : []
  return (
    <>
      <div className="meta">
        {data && <span>Fetched {clockTime(data.fetchedAt)}</span>}
        <button className="ghost btn" type="button" disabled={offline} onClick={reload}>
          Refresh
        </button>
        {running && <span>Refreshes every 15 s while it runs</span>}
      </div>
      {error && <div className="error-text">{error}</div>}
      {diff && (files.length || diff.untrackedFiles.length) ? (
        <>
          <div className="files">
            {files.map(file => (
              <div key={file.name} className="file">
                <span className="name" title={file.name}>
                  {file.name}
                </span>
                <span className="add">+{file.added}</span>
                <span className="del">−{file.removed}</span>
              </div>
            ))}
            {diff.untrackedFiles.map(file => (
              <div key={file} className="file">
                <span className="name" title={file}>
                  {file}
                </span>
                <span className="faint">new</span>
              </div>
            ))}
          </div>
          {diff.patch && (
            <div className="patch">
              {patchLines(diff.patch).map((line, index) => (
                <div key={index} className={line.kind === 'context' ? undefined : line.kind}>
                  {line.text || ' '}
                </div>
              ))}
            </div>
          )}
          {diff.truncated && <div className="faint">The diff is too long to show in full.</div>}
        </>
      ) : (
        data && <div className="faint">No changes against where it started.</div>
      )}
    </>
  )
}

function WorkerActions({
  worker,
  modelLine,
  offline,
  onError,
}: {
  worker: Worker
  modelLine: string
  offline: boolean
  onError: (message: string) => void
}) {
  const [text, setText] = useState('')
  const fail = (error: unknown) => onError(error instanceof Error ? error.message : String(error))
  if (worker.status === 'running')
    return (
      <div className="insp-actions">
        <button className="ghost btn" type="button" disabled={offline} onClick={() => void api.stopWorker(worker.id).catch(fail)}>
          <Square className="size-3" />
          Stop
        </button>
        <span className="faint text-xs">Next turn: {modelLine}</span>
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
      className="insp-actions"
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
        placeholder="Message this worker"
        value={text}
        disabled={offline}
        onChange={event => setText(event.target.value)}
      />
      <button className="ghost btn" type="submit" disabled={offline || !text.trim()}>
        Send
      </button>
    </form>
  )
}

function Head({ title, children, onBack, onClose }: { title: string; children?: ReactNode } & Pick<InspectorProps, 'onBack' | 'onClose'>) {
  return (
    <div className="insp-head">
      <div className="insp-top">
        <button className="ghost back" type="button" aria-label="Back" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </button>
        <span className="insp-title">{title}</span>
        <button className="ghost close" type="button" aria-label="Close inspector" onClick={onClose}>
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
      <div className="field-label">{label}</div>
      <Markdown text={text} />
    </div>
  )
}

function Placeholder({ error, ...props }: InspectorProps & { error: string | null }) {
  return (
    <>
      <Head title="" {...props} />
      <div className="insp-body">{error ? <div className="error-text">{error}</div> : <div className="faint">Loading…</div>}</div>
    </>
  )
}
