import type { AppState, ChatDetail, ChatRecord, Engine, QuotaSnapshot, RunDetail, RunSummary, Worktree } from './types.js'

type WorkerOptions = { engine: Engine; model?: string; effort?: string }
type RunStarted = RunSummary & { quotaNote?: string }

const runPath = (id: string) => `/api/runs/${encodeURIComponent(id)}`
const chatPath = (id: string) => `/api/chats/${encodeURIComponent(id)}`

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', ...init })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(typeof body?.error === 'string' ? body.error : `Grip returned HTTP ${response.status}`)
  }
  return response.json()
}

function write<T>(path: string, body: unknown = {}, method: 'POST' | 'DELETE' = 'POST'): Promise<T> {
  return request<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

export const api = {
  state: (signal: AbortSignal) => request<AppState>('/api/state', { signal }),
  chat: (id: string, signal: AbortSignal) => request<ChatDetail>(chatPath(id), { signal }),
  run: (id: string, signal: AbortSignal) => request<RunDetail>(runPath(id), { signal }),
  worktrees: (signal: AbortSignal) => request<Worktree[]>('/api/worktrees', { signal }),
  startChat: (input: WorkerOptions & { folder: string; message: string }) => write<ChatRecord>('/api/chats', input),
  startRun: (input: WorkerOptions & { folder: string; brief: { text: string } | { path: string } }) =>
    write<RunStarted>('/api/runs', input),
  messageChat: (id: string, text: string) => write<ChatRecord>(`${chatPath(id)}/message`, { text }),
  messageRun: (id: string, text: string) => write<RunSummary>(`${runPath(id)}/message`, { text }),
  stopChat: (id: string) => write<ChatRecord>(`${chatPath(id)}/stop`),
  stopRun: (id: string) => write<RunSummary>(`${runPath(id)}/stop`),
  retry: (id: string, input: WorkerOptions) => write<RunStarted>(`${runPath(id)}/retry`, input),
  stopAll: () => write<{ stopped: RunSummary[]; stoppedChats: ChatRecord[]; killedWorkers: boolean }>('/api/stop-all'),
  refreshQuota: (readClaude = false) =>
    write<QuotaSnapshot>('/api/quota/refresh', readClaude ? { providers: ['claude'] } : { providers: ['codex', 'agy'] }),
  removeWorktree: (path: string) => write<{ branchDeleted: boolean; branch: string }>('/api/worktrees', { path }, 'DELETE'),
}

export const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Grip could not complete that request.')
