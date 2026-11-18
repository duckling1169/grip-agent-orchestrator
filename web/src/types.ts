import type { Chat } from '../../src/chats/store.js'
import type { TimelineEntry } from '../../src/chats/timeline.js'
import type { ClawHistoryEntry } from '../../src/claw/state.js'
import type { QuotaSnapshot } from '../../src/quota/quota.js'
import type { present, summarize } from '../../src/runs/present.js'
import type { Engine } from '../../src/runs/store.js'
import type { EngineModels, ModelOption } from '../../src/models.js'
import type { FolderEntry, FolderListing } from '../../src/web/folders.js'
import type { Machine, MachineList } from '../../src/web/machines.js'

export type { Engine, EngineModels, FolderEntry, FolderListing, Machine, MachineList, ModelOption, QuotaSnapshot, TimelineEntry }
export type RunSummary = ReturnType<typeof summarize>
export type RunDetail = ReturnType<typeof present>
export type ChatRecord = Pick<
  Chat,
  | 'id'
  | 'kind'
  | 'title'
  | 'engine'
  | 'model'
  | 'effort'
  | 'folder'
  | 'host'
  | 'status'
  | 'error'
  | 'turns'
  | 'waiting'
  | 'createdAt'
  | 'updatedAt'
>
export type ChatSummary = ChatRecord & { runs: RunSummary[] }
export type ChatDetail = { chat: ChatRecord; runs: RunSummary[]; timeline: TimelineEntry[] }
export type ClawState = { status: string; version: string | null; history?: readonly ClawHistoryEntry[] }

export type AppState = {
  you: string
  principal: { host: string; online: boolean }
  claw: ClawState
  keepAwake: { supported: boolean; holding: boolean }
  quota: QuotaSnapshot
  chats: ChatSummary[]
  runs: RunSummary[]
}

export type Worktree = {
  path: string
  branch: string
  ageMs: number | null
  repo: string
  bytes: number
  sizeComplete: boolean
  run: RunSummary | null
}

export type Route = { kind: 'home' } | { kind: 'chat' | 'run'; id: string }
