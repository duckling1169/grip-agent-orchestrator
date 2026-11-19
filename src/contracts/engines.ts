export type ClawEngine = 'claude' | 'codex-app' | 'agy' | 'cursor' | 'grok' | 'opencode' | 'acp'
export type ClawPermissionMode = 'auto'

export type EngineSpec = {
  name: string
  claw: ClawEngine
  acpAgent?: string
  bin: string
  permissionMode?: ClawPermissionMode
}

export const ENGINE_SPECS = {
  claude: { name: 'Claude', claw: 'claude', bin: 'claude', permissionMode: 'auto' },
  codex: { name: 'Codex', claw: 'codex-app', bin: 'codex' },
  agy: { name: 'Gemini', claw: 'agy', bin: 'agy', permissionMode: 'auto' },
  cursor: { name: 'Cursor', claw: 'cursor', bin: 'cursor-agent' },
  grok: { name: 'Grok', claw: 'grok', bin: 'grok', permissionMode: 'auto' },
  opencode: { name: 'OpenCode', claw: 'opencode', bin: 'opencode' },
  kimi: { name: 'Kimi', claw: 'acp', acpAgent: 'kimi-code', bin: 'kimi' },
  deepseek: { name: 'DeepSeek', claw: 'acp', acpAgent: 'dsh', bin: 'dsh' },
} as const satisfies Record<string, EngineSpec>

export type Engine = keyof typeof ENGINE_SPECS
export const ENGINES = Object.keys(ENGINE_SPECS) as Engine[]

export function engineSpec(engine: Engine): EngineSpec {
  return ENGINE_SPECS[engine]
}

export function isEngine(value: string): value is Engine {
  return Object.hasOwn(ENGINE_SPECS, value)
}
