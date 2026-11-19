import type { Engine } from './engines.js'

export type TaskStatus = 'working' | 'done'

export type Task = {
  id: string
  title: string
  repoRoot: string | null
  plan: string
  notes: string
  testing: string
  status: TaskStatus
  revision: string | null
  howToTry: string | null
  supersededBy: string | null
  createdAt: string
  updatedAt: string
}

export type IntegrationStatus = 'running' | 'merged' | 'refused' | 'interrupted'

export type Integration = {
  id: number
  taskId: string
  workerId: string
  repoRoot: string
  branch: string
  status: IntegrationStatus
  revision: string | null
  error: string | null
  startedAt: string
  endedAt: string | null
}

export type TurnStatus = 'running' | 'finished' | 'failed' | 'stopped' | 'interrupted'

export type WorkerRepo = { root: string; branch: string; base: string; baseCommit: string }

export type Worker = {
  id: string
  taskId: string | null
  title: string
  engine: Engine
  model: string | null
  effort: string | null
  folder: string
  cwd: string
  repo: WorkerRepo | null
  nativeSessionId: string | null
  createdAt: string
  status: TurnStatus
  turnCount: number
}

export type Turn = {
  number: number
  model: string | null
  effort: string | null
  input: string
  output: string | null
  status: TurnStatus
  error: string | null
  startedAt: string
  endedAt: string | null
}

export type WorktreeDiff = {
  stat: string
  patch: string
  truncated: boolean
  untrackedFiles: string[]
  skippedFiles: { file: string; reason: string }[]
}

export type LeaderTurnStatus = 'running' | 'finished' | 'failed' | 'stopped' | 'interrupted'

export type Recovery = { provider: Engine; resetsAt: string | null; suggested: LeaderSettings | null; reason: string }

export type LeaderTurn = {
  id: number
  engine: Engine
  model: string | null
  effort: string | null
  status: LeaderTurnStatus
  output: string | null
  error: string | null
  startedAt: string
  endedAt: string | null
  retried: boolean
  recovery: Recovery | null
}

export type LeaderSettings = { engine: Engine; model: string | null; effort: string | null }

export type ConversationEntry =
  | { type: 'user'; inboxId: number; source: string; text: string; at: string; leaderTurnId: number | null }
  | { type: 'moxy'; turn: LeaderTurn }

export type UsageWindow = { name: string; usedPercent: number; resetsAt: string | null; stale: boolean; observedAt: string | null }

export type EngineUsage = { engine: Engine; windows: UsageWindow[] }

export type EngineQuota = EngineUsage & { checkedAt: string | null; error: string | null; busy: boolean }

export type ModelOption = { id: string; label: string; efforts: string[]; defaultEffort: string | null; isDefault: boolean }

export type EngineModels = { engine: Engine; models: ModelOption[]; error: string | null }

export type MoxySettings = { quotaRefreshMinutes: number }

export type Snapshot = {
  revision: number
  login: string
  host: string
  leader: LeaderSettings
  settings: MoxySettings
  quota: EngineQuota[]
  conversation: ConversationEntry[]
  tasks: Task[]
  workers: Worker[]
}

export type TaskDetail = { task: Task; workers: Worker[]; integrations: Integration[] }

export type WorkerDetail = { worker: Worker; turns: Turn[] }

export type WorkerChanges = { diff: WorktreeDiff | null; fetchedAt: string }

export type PostedMessage = { source: string; received: boolean }
