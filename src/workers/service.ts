import { randomBytes } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { engineSpec } from '../contracts/engines.js'
import type { Engine } from '../contracts/engines.js'
import { errorText } from '../errors.js'
import type { Log } from '../log.js'
import { protectedFolderOf } from '../repos/folders.js'
import type { WorktreeDiff, WorktreeFacts, Worktrees } from '../repos/worktrees.js'
import type { ClawSendResult, ClawSessions } from '../runtime/claw/client.js'
import type { Turn, TurnEnding, TurnRef, Worker, WorkerStore } from './store.js'

export type DelegateInput = {
  folder: string
  engine: Engine
  prompt: string
  title?: string
  model?: string
  effort?: string
}

export type WorkerResult = {
  worker: Worker
  turns: Turn[]
  facts: WorktreeFacts | null
  diff: WorktreeDiff | null
}

export type Reconciliation = { interruptedTurns: TurnRef[]; orphanedSessions: string[] }

export type WorkersOptions = {
  store: WorkerStore
  claw: ClawSessions
  worktrees: Worktrees
  protectedFolders: readonly string[]
  isInstalled: (engine: Engine) => boolean
  log: Log
  turnTimeoutMs?: number
  onTurnEnded?: (worker: Worker, turn: Turn) => void
}

export const MOXY_MCP_TOOLS = 'mcp__moxy'
export const SESSION_PREFIX = 'moxy-w-'
const DEFAULT_TURN_TIMEOUT_MS = 3 * 24 * 60 * 60_000
const TITLE_MAX_LENGTH = 80

export const WORKER_PROMPT =
  'You are a worker started by Moxy. You may use subagents for parts of this task, but wait for each one to finish ' +
  'before you reply. Do not leave subagents or background jobs running when your turn ends: they stop with it, and ' +
  'nobody sees their results.'

export class Workers {
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(private readonly options: WorkersOptions) {}

  private get store(): WorkerStore {
    return this.options.store
  }

  async delegate(input: DelegateInput): Promise<Worker> {
    const prompt = input.prompt.trim()
    if (!prompt) throw new Error('a prompt is required')
    if (!this.options.isInstalled(input.engine)) {
      throw new Error(`${engineSpec(input.engine).name} is not installed on this machine (no ${engineSpec(input.engine).bin} on PATH)`)
    }
    const folder = await this.workableFolder(input.folder)
    const id = randomBytes(4).toString('hex')
    const title = input.title?.trim() || titleFrom(prompt)
    const repo = await this.options.worktrees.repoOf(folder)
    const planned = repo ? await this.options.worktrees.plan(repo, { engine: input.engine, title, id }) : null

    const worker = this.store.create(
      {
        id,
        title,
        engine: input.engine,
        model: input.model ?? null,
        effort: input.effort ?? null,
        folder,
        cwd: planned?.path ?? folder,
        repo: planned && { root: planned.repoRoot, branch: planned.branch, base: planned.base, baseCommit: planned.baseCommit },
      },
      prompt,
    )
    if (planned) {
      try {
        await this.options.worktrees.add(planned)
      } catch (error) {
        this.store.endTurn(
          { workerId: id, number: 1 },
          { status: 'failed', output: null, error: `could not create the worktree: ${errorText(error)}` },
        )
        throw error
      }
    }
    this.runInBackground(worker, { workerId: id, number: 1 }, prompt)
    return this.store.mustGet(id)
  }

  message(id: string, text: string): Worker {
    const message = text.trim()
    if (!message) throw new Error('message is empty')
    if (this.inFlight.has(id)) throw new Error(`worker ${id} is still finishing its last turn`)
    const number = this.store.startTurn(id, message)
    this.runInBackground(this.store.mustGet(id), { workerId: id, number }, message)
    return this.store.mustGet(id)
  }

  async stop(id: string): Promise<Worker> {
    if (this.store.stopRunningTurn(id)) await this.options.claw.stopSession(sessionName(id)).catch(() => undefined)
    return this.store.mustGet(id)
  }

  async result(id: string, options: { diff?: boolean } = {}): Promise<WorkerResult> {
    const worker = this.store.mustGet(id)
    const repo = worker.repo
    const facts = repo ? await this.options.worktrees.facts(worker.cwd, repo.baseCommit) : null
    const diff = repo && options.diff ? await this.options.worktrees.diff(worker.cwd, repo.baseCommit) : null
    return { worker, turns: this.store.turns(id), facts, diff }
  }

  list(): Worker[] {
    return this.store.list()
  }

  async reconcile(): Promise<Reconciliation> {
    const interruptedTurns = this.store.interruptRunningTurns('Moxy restarted during this turn')
    const interruptedWorkers = new Set(interruptedTurns.map(turn => turn.workerId))
    const leftover = (await this.options.claw.listSessions()).map(session => session.name).filter(name => name.startsWith(SESSION_PREFIX))
    await Promise.all(leftover.map(name => this.options.claw.stopSession(name).catch(() => undefined)))
    return { interruptedTurns, orphanedSessions: leftover.filter(name => !interruptedWorkers.has(name.slice(SESSION_PREFIX.length))) }
  }

  interruptAll(): TurnRef[] {
    return this.store.interruptRunningTurns('Moxy stopped during this turn')
  }

  async settled(id: string): Promise<void> {
    await this.inFlight.get(id)
  }

  async idle(): Promise<void> {
    await Promise.all(this.inFlight.values())
  }

  private async workableFolder(asked: string): Promise<string> {
    const folder = await realpath(resolve(asked)).catch(() => {
      throw new Error(`folder not found: ${asked}`)
    })
    if (!(await stat(folder)).isDirectory()) throw new Error(`not a folder: ${asked}`)
    const guarded = protectedFolderOf(folder, this.options.protectedFolders)
    if (guarded) throw new Error(`refusing to run a worker in ${folder}: it is inside protected folder ${guarded}`)
    return folder
  }

  private runInBackground(worker: Worker, turn: TurnRef, input: string): void {
    const work = this.runTurn(worker, turn, input)
      .catch(error => this.options.log(`worker ${worker.id} turn ${turn.number} could not be recorded: ${errorText(error)}`))
      .finally(() => this.inFlight.delete(worker.id))
    this.inFlight.set(worker.id, work)
  }

  private async runTurn(worker: Worker, turn: TurnRef, input: string): Promise<void> {
    const claw = this.options.claw
    const name = sessionName(worker.id)
    const spec = engineSpec(worker.engine)
    let ending: TurnEnding
    try {
      await claw.startSession({
        name,
        cwd: worker.cwd,
        engine: spec.claw,
        ...(spec.acpAgent ? { acpAgent: spec.acpAgent } : {}),
        ...(spec.permissionMode ? { permissionMode: spec.permissionMode } : {}),
        ...(worker.model ? { model: worker.model } : {}),
        ...(worker.effort ? { effort: worker.effort } : {}),
        ...(worker.nativeSessionId ? { resumeSessionId: worker.nativeSessionId } : {}),
        ...(worker.engine === 'claude' ? { disallowedTools: [MOXY_MCP_TOOLS], appendSystemPrompt: WORKER_PROMPT } : {}),
      })
      if (this.store.turnStatus(turn) !== 'running') throw new Error('stopped before the turn began')
      const sent = await claw.sendMessage(name, input, {
        timeoutMs: this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
        ...(worker.effort ? { effort: worker.effort } : {}),
      })
      ending = {
        status: sent.error ? 'failed' : 'finished',
        output: outputWithDenials(sent),
        error: sent.error ?? null,
        nativeSessionId: sent.sessionId ?? null,
      }
    } catch (error) {
      ending = { status: 'failed', output: null, error: errorText(error) }
    } finally {
      await claw.stopSession(name).catch(() => undefined)
    }
    const ended = this.store.endTurn(turn, ending)
    this.options.onTurnEnded?.(this.store.mustGet(worker.id), ended)
  }
}

export function sessionName(workerId: string): string {
  return `${SESSION_PREFIX}${workerId}`
}

function titleFrom(prompt: string): string {
  const firstLine = (prompt.split(/\r?\n/).find(line => line.trim()) ?? prompt).replace(/^#+\s*/, '').trim()
  return firstLine.length > TITLE_MAX_LENGTH ? `${firstLine.slice(0, TITLE_MAX_LENGTH - 1)}…` : firstLine
}

function outputWithDenials(sent: ClawSendResult): string {
  const denied = sent.permissionDenials ?? []
  if (denied.length === 0) return sent.output
  return `${sent.output}\n\n[moxy] ${denied.length} tool call(s) were denied: ${denied.map(denial => denial.toolName).join(', ')}`
}
