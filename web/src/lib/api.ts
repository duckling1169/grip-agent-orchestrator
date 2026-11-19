import type {
  EngineModels,
  EngineQuota,
  MoxySettings,
  LeaderSettings,
  LeaderTurn,
  PostedMessage,
  Snapshot,
  TaskDetail,
  Worker,
  WorkerChanges,
  WorkerDetail,
} from '@contracts/api'
import type { Engine } from '@contracts/engines'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', ...init })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(typeof body?.error === 'string' ? body.error : `Moxy returned HTTP ${response.status}`)
  }
  return response.json()
}

function post<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

const workerPath = (id: string) => `/api/workers/${encodeURIComponent(id)}`

export const api = {
  state: () => request<Snapshot>('/api/state'),
  models: (engine: Engine, signal?: AbortSignal) => request<EngineModels>(`/api/models/${engine}`, { signal }),
  refreshQuota: (engine: Engine) => post<EngineQuota[]>(`/api/quota/${engine}/refresh`),
  settings: (settings: MoxySettings) => post<MoxySettings>('/api/settings', settings),
  send: (text: string, id: string) => post<PostedMessage>('/api/messages', { text, id }),
  stop: () => post<{ stopped: boolean }>('/api/leader/stop'),
  sendNow: () => post<{ stopped: boolean }>('/api/leader/send-now'),
  retry: (turnId: number) => post<LeaderTurn>('/api/leader/retry', { turnId }),
  configure: (settings: Pick<LeaderSettings, 'model' | 'effort'>) => post<LeaderSettings>('/api/leader/settings', settings),
  task: (id: string, signal?: AbortSignal) => request<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`, { signal }),
  worker: (id: string, signal?: AbortSignal) => request<WorkerDetail>(workerPath(id), { signal }),
  changes: (id: string, signal?: AbortSignal) => request<WorkerChanges>(`${workerPath(id)}/changes`, { signal }),
  messageWorker: (id: string, text: string) => post<Worker>(`${workerPath(id)}/message`, { text }),
  stopWorker: (id: string) => post<Worker>(`${workerPath(id)}/stop`),
}
