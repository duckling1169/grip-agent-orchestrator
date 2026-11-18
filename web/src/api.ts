import type {
  AppState,
  ChatDetail,
  ChatRecord,
  Engine,
  EngineLeader,
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

function write<T>(path: string, body: unknown = {}, method: 'POST' | 'DELETE' = 'POST', local = false): Promise<T> {
  return request<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, local)
}

export type PushEvent = 'run-done' | 'run-failed' | 'claw-rolled-back' | 'principal-offline'
export type PushDevice = { muted: PushEvent[] }

/**
 * Notifications always go through the machine that served the page: its service worker holds the
 * subscription, and only its Grip has the key the subscription was made for.
 */
export const pushApi = {
  info: () => request<{ publicKey: string; events: PushEvent[] } | null>('/api/push', undefined, true),
  device: (endpoint: string) => write<PushDevice | null>('/api/push/device', { endpoint }, 'POST', true),
  subscribe: (subscription: PushSubscriptionJSON) => write<PushDevice>('/api/push/subscribe', { subscription }, 'POST', true),
  setMuted: (endpoint: string, muted: PushEvent[]) => write<PushDevice>('/api/push/muted', { endpoint, muted }, 'POST', true),
  /** A test to every device you turned notifications on, not just this one. */
  test: () => write<{ devices: number; sent: number; errors: string[] }>('/api/push/test', {}, 'POST', true),
  unsubscribe: (endpoint: string) => write<null>('/api/push/device', { endpoint }, 'DELETE', true),
}

export const api = {
  state: (signal: AbortSignal) => request<AppState>('/api/state', { signal }),
  /** Always from the machine that served the page, so the list is the same whichever is chosen. */
  machines: (signal?: AbortSignal) => request<MachineList>('/api/machines', { signal }, true),
  chat: (id: string, signal: AbortSignal) => request<ChatDetail>(chatPath(id), { signal }),
  run: (id: string, signal: AbortSignal) => request<RunDetail>(runPath(id), { signal }),
  worktrees: (signal: AbortSignal) => request<Worktree[]>('/api/worktrees', { signal }),
  models: (signal: AbortSignal) => request<EngineModels[]>('/api/models', { signal }),
  leaders: (signal: AbortSignal) => request<EngineLeader[]>('/api/leaders', { signal }),
  folders: (path: string | null, signal: AbortSignal) =>
    request<FolderListing>(path ? `/api/folders?path=${encodeURIComponent(path)}` : '/api/folders', { signal }),
  startChat: (input: WorkerOptions & { folder: string; message?: string }) => write<ChatRecord>('/api/chats', input),
  startRun: (input: WorkerOptions & { folder: string; brief: { text: string } | { path: string } }) =>
    write<RunStarted>('/api/runs', input),
  messageChat: (id: string, text: string) => write<ChatRecord>(`${chatPath(id)}/message`, { text }),
  messageRun: (id: string, text: string) => write<RunSummary>(`${runPath(id)}/message`, { text }),
  deleteChat: (id: string) => write<{ deleted: string }>(chatPath(id), {}, 'DELETE'),
  deleteRun: (id: string) => write<{ deleted: string }>(runPath(id), {}, 'DELETE'),
  renameChat: (id: string, title: string) => write<ChatRecord>(`${chatPath(id)}/rename`, { title }),
  renameRun: (id: string, title: string) => write<RunSummary>(`${runPath(id)}/rename`, { title }),
  /** Model and effort for the chat's next turns; null is the agent's default. */
  chatSettings: (id: string, settings: { model: string | null; effort: string | null }) =>
    write<ChatRecord>(`${chatPath(id)}/settings`, settings),
  runSettings: (id: string, settings: { model: string | null; effort: string | null }) =>
    write<RunSummary>(`${runPath(id)}/settings`, settings),
  stopChat: (id: string) => write<ChatRecord>(`${chatPath(id)}/stop`),
  stopRun: (id: string) => write<RunSummary>(`${runPath(id)}/stop`),
  retry: (id: string, input: WorkerOptions) => write<RunStarted>(`${runPath(id)}/retry`, input),
  stopAll: () => write<{ stopped: RunSummary[]; stoppedChats: ChatRecord[]; killedWorkers: boolean }>('/api/stop-all'),
  /** Every agent, Claude's one-line probe included, as the quota timer reads them. */
  refreshQuota: () => write<QuotaSnapshot>('/api/quota/refresh', { providers: ['claude', 'codex', 'agy'] }),
  removeWorktree: (path: string) => write<{ branchDeleted: boolean; branch: string }>('/api/worktrees', { path }, 'DELETE'),
}

export const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Grip could not complete that request.')
