import { ArrowLeft, X } from 'lucide-react'
import type { ReactNode } from 'react'

import type { Worker, WorkerActivity } from '@contracts/api'
import { engineName } from '@/components/engine-icon'
import { api } from '@/lib/api'
import { clockTime, elapsed } from '@/lib/format'
import type { Selection } from '@/lib/selection'
import { errorText, ghost, meta } from '@/lib/styles'
import { useFetched } from '@/lib/use-fetched'
import { cn } from '@/lib/utils'

const ACTIVITY_REFRESH_MS = 10_000
export const SUBTITLE = 'flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground'
export const BODY = 'flex flex-1 flex-col gap-4 overflow-auto px-4 py-3.5'

export type InspectorProps = {
  revision: number
  offline: boolean
  onSelect: (selection: Selection) => void
  onBack: () => void
  onClose: () => void
  onError: (message: string) => void
}

export function ActivityLines({ worker, activity, className }: { worker: Worker; activity: WorkerActivity | null; className?: string }) {
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

export function useActivity(worker: Worker): WorkerActivity | null {
  const running = worker.status === 'running'
  const { data } = useFetched(
    signal => api.activity(worker.id, signal),
    [worker.id, worker.status, worker.turnCount],
    running ? ACTIVITY_REFRESH_MS : null,
  )
  return data
}

export function modelLine(worker: Worker): string {
  return [engineName(worker.engine), worker.model, worker.effort].filter(Boolean).join(' · ')
}

export function timing(worker: Worker): string {
  const started = `Started ${clockTime(worker.createdAt)}`
  if (worker.status !== 'running') return started
  const turn = worker.turnCount > 1 ? `turn ${worker.turnCount} running` : 'running'
  return `${started} · ${turn} ${elapsed(worker.turnStartedAt, null)}`
}

export function Head({
  title,
  children,
  onBack,
  onClose,
}: { title: string; children?: ReactNode } & Pick<InspectorProps, 'onBack' | 'onClose'>) {
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

export function Placeholder({ error, ...props }: InspectorProps & { error: string | null }) {
  return (
    <>
      <Head title="" {...props} />
      <div className={BODY}>{error ? <div className={errorText}>{error}</div> : <div className="text-faint">Loading…</div>}</div>
    </>
  )
}
