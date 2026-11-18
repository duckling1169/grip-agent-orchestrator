import { exec as defaultExec, spawnPiped as defaultSpawn } from './exec.js'
import type { Exec, SpawnPiped } from './exec.js'
import { codexCli, codexRpc } from './quota/readers.js'
import type { Engine } from './runs/store.js'
import { DEFAULT_SETTINGS, minutes } from './settings.js'

/** A model an agent can run, with the efforts it accepts. An empty `efforts` means it takes none. */
export type ModelOption = { id: string; label: string; efforts: string[]; defaultEffort: string | null; isDefault: boolean }

/** One agent's models. `error` says why the list could not be read; the agent default still works. */
export type EngineModels = { engine: Engine; models: ModelOption[]; error: string | null }

export interface ModelReaders {
  /** Codex app-server `model/list`: an account read, no quota spent. */
  codex(): Promise<ModelOption[]>
  /** `agy models`: a built-in command, no model turn. Each model already names its effort. */
  agy(): Promise<ModelOption[]>
}

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Claude Code has no command that lists models, so Grip lists the current ones. Each id is a
 * full model id that `claude --model` accepts.
 */
export const CLAUDE_MODELS: ModelOption[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: CLAUDE_EFFORTS, defaultEffort: null, isDefault: false },
  { id: 'claude-fable-5-2', label: 'Fable 5.2', efforts: CLAUDE_EFFORTS, defaultEffort: null, isDefault: false },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: CLAUDE_EFFORTS, defaultEffort: null, isDefault: false },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', efforts: [], defaultEffort: null, isDefault: false },
]

/** Model lists per agent, read again after `cacheMs` (settings.modelListRefreshMinutes). A failed read is retried on the next ask. */
export class ModelCatalog {
  private cached: { at: number; value: Promise<EngineModels[]> } | null = null

  constructor(
    private readonly readers: ModelReaders = new CliModelReaders(),
    private readonly now: () => number = Date.now,
    private readonly cacheMs: number = minutes(DEFAULT_SETTINGS.modelListRefreshMinutes),
  ) {}

  list(): Promise<EngineModels[]> {
    if (this.cached && this.now() - this.cached.at < this.cacheMs) return this.cached.value
    const value = Promise.all([
      Promise.resolve<EngineModels>({ engine: 'claude', models: CLAUDE_MODELS, error: null }),
      read('codex', () => this.readers.codex()),
      read('agy', () => this.readers.agy()),
    ])
    const entry = { at: this.now(), value }
    this.cached = entry
    void value.then(lists => {
      if (lists.some(l => l.error) && this.cached === entry) this.cached = null
    })
    return value
  }
}

async function read(engine: Engine, load: () => Promise<ModelOption[]>): Promise<EngineModels> {
  try {
    return { engine, models: await load(), error: null }
  } catch (error) {
    return { engine, models: [], error: (error as Error).message }
  }
}

export class CliModelReaders implements ModelReaders {
  private codexCommand: Promise<[string, string[]]> | null = null

  constructor(
    private readonly run: Exec = defaultExec,
    private readonly spawn: SpawnPiped = defaultSpawn,
  ) {}

  async codex(): Promise<ModelOption[]> {
    const [command, prefix] = await (this.codexCommand ??= codexCli(this.run))
    return parseCodexModels(await codexRpc(this.spawn, command, [...prefix, 'app-server'], 'model/list', {}))
  }

  async agy(): Promise<ModelOption[]> {
    const out = await this.run('agy', ['models'], { timeoutMs: 60_000 })
    if (out.code !== 0) throw new Error(`agy models: ${out.stderr.trim().split(/\r?\n/).pop() || `exit ${out.code}`}`)
    return parseAgyModels(out.stdout)
  }
}

/** The result of Codex's `model/list`. Hidden models are left out. */
export function parseCodexModels(result: unknown): ModelOption[] {
  const data = (result as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) throw new Error('codex model/list: no model data')
  return data.flatMap((m: Record<string, unknown>): ModelOption[] => {
    const id = typeof m.model === 'string' ? m.model : typeof m.id === 'string' ? m.id : null
    if (!id || m.hidden === true) return []
    const efforts = Array.isArray(m.supportedReasoningEfforts)
      ? m.supportedReasoningEfforts.flatMap((e: { reasoningEffort?: unknown }) =>
          typeof e?.reasoningEffort === 'string' ? [e.reasoningEffort] : [],
        )
      : []
    return [
      {
        id,
        label: typeof m.displayName === 'string' ? m.displayName : id,
        efforts,
        defaultEffort: typeof m.defaultReasoningEffort === 'string' ? m.defaultReasoningEffort : null,
        isDefault: m.isDefault === true,
      },
    ]
  })
}

/** `agy models` prints one `id<TAB>name` line per model after a status line. */
export function parseAgyModels(stdout: string): ModelOption[] {
  return stdout.split(/\r?\n/).flatMap(line => {
    const [id, label] = line.split('\t').map(part => part.trim())
    return id && label && /^[\w.-]+$/.test(id) ? [{ id, label, efforts: [], defaultEffort: null, isDefault: false }] : []
  })
}
