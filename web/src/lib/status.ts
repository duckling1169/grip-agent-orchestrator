import type { Task, TurnStatus, Worker } from '@contracts/api'

export const STATUS_LABELS: Record<TurnStatus, string> = {
  running: 'Working',
  finished: 'Finished',
  failed: 'Failed',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
}

export const TASK_LABELS: Record<Task['status'], string> = { working: 'Working', waiting: 'Waiting on you', done: 'Done' }

export function rowTone(status: TurnStatus): string {
  if (status === 'failed') return 'failed'
  if (status === 'stopped' || status === 'interrupted') return 'stopped'
  return ''
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
