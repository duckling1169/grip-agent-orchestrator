import type {
  AppState,
  ChatDetail,
  ChatRecord,
  Engine,
  EngineModels,
  FolderListing,
  MachineList,
  QuotaSnapshot,
  RunDetail,
  RunSummary,
  Worktree,
} from './types.js'
import { apiUrl, machineBase } from './machine.js'

type WorkerOptions = { engine: Engine; model?: string; effort?: string }
type RunStarted = RunSummary & { quotaNote?: string }

const runPath = (id: string) => `/api/runs/${encodeURIComponent(id)}`
const chatPath = (id: string) => `/api/chats/${encodeURIComponent(id)}`

/** Calls the chosen machine's Grip; `local` calls the machine that served the page. */
async function request<T>(path: string, init?: RequestInit, local = false): Promise<T> {
  const response = await fetch(local ? path : apiUrl(path, machineBase()), { cache: 'no-store', ...init })
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
  /** Always from the machine that served the page, so the list is the same whichever is chosen. */
  machines: (signal?: AbortSignal) => request<MachineList>('/api/machines', { signal }, true),
  chat: (id: string, signal: AbortSignal) => request<ChatDetail>(chatPath(id), { signal }),
  run: (id: string, signal: AbortSignal) => request<RunDetail>(runPath(id), { signal }),
  worktrees: (signal: AbortSignal) => request<Worktree[]>('/api/worktrees', { signal }),
  models: (signal: AbortSignal) => request<EngineModels[]>('/api/models', { signal }),
  folders: (path: string | null, signal: AbortSignal) =>
    request<FolderListing>(path ? `/api/folders?path=${encodeURIComponent(path)}` : '/api/folders', { signal }),
  startChat: (input: WorkerOptions & { folder: string; message?: string }) => write<ChatRecord>('/api/chats', input),
  startRun: (input: WorkerOptions & { folder: string; brief: { text: string } | { path: string } }) =>
    write<RunStarted>('/api/runs', input),
  messageChat: (id: string, text: string) => write<ChatRecord>(`${chatPath(id)}/message`, { text }),
  messageRun: (id: string, text: string) => write<RunSummary>(`${runPath(id)}/message`, { text }),
  deleteChat: (id: string) => write<{ deleted: string }>(chatPath(id), {}, 'DELETE'),
  stopChat: (id: string) => write<ChatRecord>(`${chatPath(id)}/stop`),
  stopRun: (id: string) => write<RunSummary>(`${runPath(id)}/stop`),
  retry: (id: string, input: WorkerOptions) => write<RunStarted>(`${runPath(id)}/retry`, input),
  stopAll: () => write<{ stopped: RunSummary[]; stoppedChats: ChatRecord[]; killedWorkers: boolean }>('/api/stop-all'),
  /** Every agent, Claude's one-line probe included, as the quota timer reads them. */
  refreshQuota: () => write<QuotaSnapshot>('/api/quota/refresh', { providers: ['claude', 'codex', 'agy'] }),
  removeWorktree: (path: string) => write<{ branchDeleted: boolean; branch: string }>('/api/worktrees', { path }, 'DELETE'),
}

export const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Grip could not complete that request.')
