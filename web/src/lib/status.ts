import type { Task, TurnStatus, Worker } from '@contracts/api'

export const STATUS_LABELS: Record<TurnStatus, string> = {
  running: 'Working',
  finished: 'Finished',
  failed: 'Failed',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
}

export type TaskStage = 'working' | 'reviewing' | 'done'

export const STAGE_LABELS: Record<TaskStage, string> = { working: 'Working', reviewing: 'Reviewing', done: 'Done' }

export function taskStage(task: Task, workers: Worker[]): TaskStage {
  if (task.status === 'done') return 'done'
  return workers.some(worker => worker.status === 'running') ? 'working' : 'reviewing'
}

export type RowTone = 'failed' | 'stopped'

export function rowTone(status: TurnStatus): RowTone | null {
  if (status === 'failed') return 'failed'
  if (status === 'stopped' || status === 'interrupted') return 'stopped'
  return null
}

export function latestWorker(workers: Worker[]): Worker | null {
  return workers.reduce<Worker | null>((latest, worker) => (!latest || worker.createdAt > latest.createdAt ? worker : latest), null)
}

export function workersByTask(workers: Worker[]): Map<string, Worker[]> {
  const byTask = new Map<string, Worker[]>()
  for (const worker of workers) {
    if (!worker.taskId) continue
    byTask.set(worker.taskId, [...(byTask.get(worker.taskId) ?? []), worker])
  }
  return byTask
}
