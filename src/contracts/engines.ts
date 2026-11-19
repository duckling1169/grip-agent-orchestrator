export type ClawEngine = 'claude' | 'codex-app' | 'agy' | 'cursor' | 'grok' | 'opencode' | 'acp'
export type ClawPermissionMode = 'auto'
export type ClawSandboxMode = 'danger-full-access'

export type EngineSpec = {
  name: string
  claw: ClawEngine
  acpAgent?: string
  bin: string
  permissionMode?: ClawPermissionMode
  sandboxMode?: ClawSandboxMode
}

export const ENGINE_SPECS = {
  claude: { name: 'Claude', claw: 'claude', bin: 'claude', permissionMode: 'auto' },
  codex: { name: 'Codex', claw: 'codex-app', bin: 'codex', sandboxMode: 'danger-full-access' },
  agy: { name: 'Gemini', claw: 'agy', bin: 'agy', permissionMode: 'auto' },
  cursor: { name: 'Cursor', claw: 'cursor', bin: 'cursor-agent' },
  grok: { name: 'Grok', claw: 'grok', bin: 'grok', permissionMode: 'auto' },
  opencode: { name: 'OpenCode', claw: 'opencode', bin: 'opencode' },
  kimi: { name: 'Kimi', claw: 'acp', acpAgent: 'kimi-code', bin: 'kimi' },
  deepseek: { name: 'DeepSeek', claw: 'acp', acpAgent: 'dsh', bin: 'dsh' },
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
