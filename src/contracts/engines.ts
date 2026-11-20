export type ClawEngine = 'claude' | 'codex-app' | 'agy' | 'cursor' | 'grok' | 'opencode' | 'acp'
export type ClawPermissionMode = 'auto' | 'bypassPermissions'
export type ClawSandboxMode = 'danger-full-access'

export const FAMILY_NAMES = {
  claude: 'Claude',
  gpt: 'GPT',
  gemini: 'Gemini',
  cursor: 'Cursor',
  grok: 'Grok',
  opencode: 'OpenCode',
  kimi: 'Kimi',
  deepseek: 'DeepSeek',
} as const

export type Family = keyof typeof FAMILY_NAMES

export type EngineSpec = {
  name: string
  family: Family
  claw: ClawEngine
  acpAgent?: string
  bin: string
  permissionMode?: ClawPermissionMode
  sandboxMode?: ClawSandboxMode
}

export const ENGINE_SPECS = {
  claude: { name: 'Claude', family: 'claude', claw: 'claude', bin: 'claude', permissionMode: 'auto' },
  codex: { name: 'Codex', family: 'gpt', claw: 'codex-app', bin: 'codex', sandboxMode: 'danger-full-access' },
  agy: { name: 'Antigravity', family: 'gemini', claw: 'agy', bin: 'agy', permissionMode: 'bypassPermissions' },
  cursor: { name: 'Cursor', family: 'cursor', claw: 'cursor', bin: 'cursor-agent' },
  grok: { name: 'Grok', family: 'grok', claw: 'grok', bin: 'grok', permissionMode: 'auto' },
  opencode: { name: 'OpenCode', family: 'opencode', claw: 'opencode', bin: 'opencode' },
  kimi: { name: 'Kimi', family: 'kimi', claw: 'acp', acpAgent: 'kimi-code', bin: 'kimi' },
  deepseek: { name: 'DeepSeek', family: 'deepseek', claw: 'acp', acpAgent: 'dsh', bin: 'dsh' },
} as const satisfies Record<string, EngineSpec>

export type Engine = keyof typeof ENGINE_SPECS
export const ENGINES = Object.keys(ENGINE_SPECS) as Engine[]

export const LEADER_ENGINES = ['claude', 'codex', 'agy', 'kimi', 'deepseek'] as const satisfies readonly Engine[]

export const PLAIN_COMMANDS_RULE =
  'Write each shell command as a plain, literal command: no shell variables, loops or command substitution such as $(...), ' +
  'and one command for each step. Nobody can answer an approval prompt here, so a command that cannot be checked before it ' +
  'runs is denied. If a command is denied because it needs approval, run the same steps again as plain commands before you ' +
  'report that it is blocked.'

export function engineSpec(engine: Engine): EngineSpec {
  return ENGINE_SPECS[engine]
}

export function isEngine(value: string): value is Engine {
  return Object.hasOwn(ENGINE_SPECS, value)
}

const MODEL_FAMILIES: readonly Family[] = ['claude', 'gpt', 'gemini', 'grok', 'kimi', 'deepseek']

export function modelFamily(engine: Engine, model: string | null): Family {
  const name = model?.toLowerCase().split('/').at(-1) ?? ''
  return MODEL_FAMILIES.find(family => name.startsWith(family)) ?? ENGINE_SPECS[engine].family
}

export function sharedFamily(runs: { engine: Engine; model: string | null }[]): Family | 'mixed' | null {
  const families = new Set(runs.map(run => modelFamily(run.engine, run.model)))
  if (families.size > 1) return 'mixed'
  return families.values().next().value ?? null
}
