import { readJson, writeFileAtomic } from '../fs-util.js'

export type ClawHistoryEntry = {
  at: string
  kind: 'installed' | 'updated' | 'rolled-back' | 'gate-failed'
  from: string | null
  to: string | null
  detail?: string
}

/** `~/.grip/claw.json`: what is installed, what last passed the gate, and what happened. */
export type ClawState = {
  lastGood: string | null
  lastCheckAt: string | null
  /** A release above the major cap, waiting for the user's approval. */
  pendingMajor: string | null
  /** A release that failed the gate; not retried until a newer one appears. */
  rejected: string | null
  history: ClawHistoryEntry[]
}

const HISTORY_LIMIT = 50

export const emptyClawState = (): ClawState => ({ lastGood: null, lastCheckAt: null, pendingMajor: null, rejected: null, history: [] })

export interface ClawStateStore {
  load(): Promise<ClawState>
  save(state: ClawState): Promise<void>
}

export class FileClawStateStore implements ClawStateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<ClawState> {
    return { ...emptyClawState(), ...((await readJson<Partial<ClawState>>(this.path)) ?? {}) }
  }

  async save(state: ClawState): Promise<void> {
    await writeFileAtomic(this.path, `${JSON.stringify({ ...state, history: state.history.slice(-HISTORY_LIMIT) }, null, 2)}\n`)
  }
}

export class MemoryClawStateStore implements ClawStateStore {
  state = emptyClawState()
  async load(): Promise<ClawState> {
    return structuredClone(this.state)
  }
  async save(state: ClawState): Promise<void> {
    this.state = structuredClone(state)
  }
}
