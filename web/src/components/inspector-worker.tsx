import { Square } from 'lucide-react'
import { useState } from 'react'

import type { FileChange, Turn, Worker } from '@contracts/api'
import { modelFamily } from '@contracts/engines'
import { Markdown } from '@/components/markdown'
import { WorkerIcon } from '@/components/worker-icon'
import { api } from '@/lib/api'
import { reportingTo } from '@/lib/errors'
import { patchLines } from '@/lib/diff'
import { clockTime } from '@/lib/format'
import { STATUS_LABELS } from '@/lib/status'
import { errorText, field, fieldLabel, ghost, linkButton, meta, mono, outlineButton, working } from '@/lib/styles'
import { useFetched } from '@/lib/use-fetched'
import { cn } from '@/lib/utils'
import { ActivityLines, BODY, Head, modelLine, Placeholder, SUBTITLE, timing, useActivity } from './inspector-shared'
import type { InspectorProps } from './inspector-shared'

const CHANGES_REFRESH_MS = 15_000

const PATCH_LINE = { add: 'text-added', del: 'text-removed', hunk: 'text-faint', context: undefined }

export function WorkerInspector({ id, ...props }: InspectorProps & { id: string }) {
  const { data, error } = useFetched(signal => api.worker(id, signal), [id, props.revision])
  const [tab, setTab] = useState<'turns' | 'changes'>('turns')
  if (!data || data.worker.id !== id) return <Placeholder error={error} {...props} />
  const { worker, turns } = data
  return (
    <>
      <Head title={worker.title} {...props}>
        <div className={SUBTITLE}>
          <WorkerIcon family={modelFamily(worker)} running={worker.status === 'running'} small />
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
          <WorkerIcon family={modelFamily(worker)} running small />
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
      {data && !diff && <div className="text-faint">No worktree diff is available.</div>}
      {diff && (
        <>
          {diff.files.length ? (
            <div className="flex flex-col gap-0.75 font-mono text-xs">
              {diff.files.map(file => (
                <FileSummary key={file.path} file={file} />
              ))}
            </div>
          ) : (
            <div className="text-faint">No changes against where it started.</div>
          )}
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
      )}
    </>
  )
}

const FILE_STATUS: Record<FileChange['status'], string> = {
  added: 'new',
  modified: '',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  'type-changed': 'type changed',
  unmerged: 'unmerged',
  unknown: '',
}

function FileSummary({ file }: { file: FileChange }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <span className="min-w-0 flex-1 truncate" title={file.path}>
        {file.path}
      </span>
      {FILE_STATUS[file.status] && <span className="text-faint">{FILE_STATUS[file.status]}</span>}
      {file.skipped && <span className="text-faint">Skipped ({file.skipped})</span>}
      {file.binary && <span className="text-faint">Binary</span>}
      {file.added !== null && <span className="text-added">+{file.added}</span>}
      {file.removed !== null && <span className="text-removed">−{file.removed}</span>}
    </div>
  )
}

const ACTIONS = 'flex items-center gap-2 border-t px-4 py-2.5'

function WorkerActions({ worker, offline, onError }: { worker: Worker; offline: boolean; onError: (message: string) => void }) {
  const [text, setText] = useState('')
  const act = reportingTo(onError)
  if (worker.status === 'running')
    return (
      <div className={ACTIONS}>
        <button className={outlineButton} type="button" disabled={offline} onClick={() => void act(() => api.stopWorker(worker.id))}>
          <Square className="size-3" />
          Stop
        </button>
        <span className="text-xs text-faint">Next turn: {modelLine(worker)}</span>
      </div>
    )
  const send = () => {
    if (!text.trim()) return
    void act(() => api.messageWorker(worker.id, text.trim()).then(() => setText('')))
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
