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
  WorkerActivity,
  WorkerChanges,
  WorkerDetail,
} from '@contracts/api'
import type { Engine } from '@contracts/engines'
import type { PushReport, PushStatus, PushSubscriptionJson } from '@contracts/push'
import type { MachineList } from '@contracts/machines'

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
export const uploadPath = (id: string) => `/api/uploads/${encodeURIComponent(id)}`

export const api = {
  state: () => request<Snapshot>('/api/state'),
  machines: (refresh = false, signal?: AbortSignal) => request<MachineList>(`/api/machines${refresh ? '?refresh=true' : ''}`, { signal }),
  pushInfo: (endpoint?: string) => request<PushStatus>(`/api/push${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ''}`),
  pushSubscribe: (subscription: PushSubscriptionJson) => post<PushStatus>('/api/push/subscribe', { subscription }),
  pushUnsubscribe: (endpoint: string) => post<PushStatus>('/api/push/unsubscribe', { endpoint }),
  pushTest: () => post<PushReport>('/api/push/test'),
  models: (engine: Engine, signal?: AbortSignal) => request<EngineModels>(`/api/models/${engine}`, { signal }),
  refreshQuota: (engine: Engine) => post<EngineQuota[]>(`/api/quota/${engine}/refresh`),
  settings: (settings: MoxySettings) => post<MoxySettings>('/api/settings', settings),
  upload: (file: File) =>
    request<{ id: string }>('/api/uploads', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
        'X-File-Type': file.type,
      },
      body: file,
    }),
  send: (text: string, id: string, attachments: string[]) => post<PostedMessage>('/api/messages', { text, id, attachments }),
  stop: () => post<{ stopped: boolean }>('/api/leader/stop'),
  sendNow: () => post<{ stopped: boolean }>('/api/leader/send-now'),
  retry: (turnId: number, settings?: LeaderSettings) => post<LeaderTurn>('/api/leader/retry', { turnId, settings }),
  configure: (settings: LeaderSettings) => post<LeaderSettings>('/api/leader/settings', settings),
  task: (id: string, signal?: AbortSignal) => request<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`, { signal }),
  worker: (id: string, signal?: AbortSignal) => request<WorkerDetail>(workerPath(id), { signal }),
  changes: (id: string, signal?: AbortSignal) => request<WorkerChanges>(`${workerPath(id)}/changes`, { signal }),
  activity: (id: string, signal?: AbortSignal) => request<WorkerActivity>(`${workerPath(id)}/activity`, { signal }),
  messageWorker: (id: string, text: string) => post<Worker>(`${workerPath(id)}/message`, { text }),
  stopWorker: (id: string) => post<Worker>(`${workerPath(id)}/stop`),
}
