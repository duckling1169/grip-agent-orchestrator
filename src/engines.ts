import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'

import type { ClawEngine, ClawPermissionMode } from './claw/client.js'
import { DEFAULT_SETTINGS, minutes } from './settings.js'

export type EngineSpec = {
  /** How the app, notifications and the CLI name it: by its model family. */
  name: string
  /** The engine Claw runs it as. */
  claw: ClawEngine
  /** For Claw's `acp` engine: the bundled preset that starts it (`clawo engines`). */
  acpAgent?: string
  /** The CLI it needs, found on PATH to tell whether it is installed here. */
  bin: string
  /**
   * Lets a worker edit, run git and run tests with no approval prompts. Left out where the
   * engine's own default already does (Codex through app-server, Cursor's `--force`, ACP
   * agents) or where Claw has no mode to set (OpenCode).
   */
  permissionMode?: ClawPermissionMode
}

/**
 * Every engine Claw 7.23 can run a worker on (DESIGN §5.1). Grip offers the ones whose CLI is
 * installed. Kimi and DeepSeek go through Claw's bundled ACP presets, since Claw's HTTP API
 * starts no other ACP agent.
 */
export const ENGINE_SPECS = {
  claude: { name: 'Claude', claw: 'claude', bin: 'claude', permissionMode: 'auto' },
  codex: { name: 'GPT', claw: 'codex-app', bin: 'codex' },
  agy: { name: 'Gemini', claw: 'agy', bin: 'agy', permissionMode: 'auto' },
  gemini: { name: 'Gemini CLI', claw: 'gemini', bin: 'gemini', permissionMode: 'bypassPermissions' },
  cursor: { name: 'Cursor', claw: 'cursor', bin: 'cursor-agent' },
  grok: { name: 'Grok', claw: 'grok', bin: 'grok', permissionMode: 'auto' },
  opencode: { name: 'OpenCode', claw: 'opencode', bin: 'opencode' },
  kimi: { name: 'Kimi', claw: 'acp', acpAgent: 'kimi-code', bin: 'kimi' },
  deepseek: { name: 'DeepSeek', claw: 'acp', acpAgent: 'dsh', bin: 'dsh' },
} as const satisfies Record<string, EngineSpec>

/** The engines a run can use, as Grip names them. */
export type Engine = keyof typeof ENGINE_SPECS
export const ENGINES = Object.keys(ENGINE_SPECS) as Engine[]
export const ENGINE_NAMES = Object.fromEntries(ENGINES.map(engine => [engine, ENGINE_SPECS[engine].name])) as Record<Engine, string>

export function engineSpec(engine: Engine): EngineSpec {
  return ENGINE_SPECS[engine]
}

/** Whether a command can be found on PATH, as a shell would find it (with PATHEXT on Windows). */
export function onPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const windows = platform === 'win32'
  const path = windows ? win32 : posix
  const extensions = windows && !path.extname(bin) ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : ['']
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
  return dirs.some(dir => extensions.some(ext => exists(path.join(dir, bin + ext))))
}

/** One engine as the app's pickers see it. */
export type EngineInfo = { engine: Engine; name: string; installed: boolean }

/** Which engines are installed here, looked up again after `cacheMs` (settings.modelListRefreshMinutes). */
export class EngineCatalog {
  private cached: { at: number; value: EngineInfo[] } | null = null

  constructor(
    private readonly installed: (bin: string) => boolean = bin => onPath(bin),
    private readonly now: () => number = Date.now,
    private readonly cacheMs: number = minutes(DEFAULT_SETTINGS.modelListRefreshMinutes),
  ) {}

  list(): EngineInfo[] {
    if (this.cached && this.now() - this.cached.at < this.cacheMs) return this.cached.value
    const value = ENGINES.map(engine => ({ engine, name: ENGINE_SPECS[engine].name, installed: this.installed(ENGINE_SPECS[engine].bin) }))
    this.cached = { at: this.now(), value }
    return value
  }

  isInstalled(engine: Engine): boolean {
    return this.list().some(info => info.engine === engine && info.installed)
  }
}
