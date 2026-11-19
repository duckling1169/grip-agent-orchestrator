import type { Engine } from '../../contracts/engines.js'

export type McpEndpoint = { url: string; token: string }

export type LeaderTurnRequest = {
  engine: Engine
  model: string | null
  effort: string | null
  nativeSessionId: string | null
  sessionKey?: string
  cwd: string
  systemPrompt: string
  message: string
  freshContext?: string
  mcp: McpEndpoint
  timeoutMs: number
}

export type LeaderReply = {
  output: string
  error: string | null
  nativeSessionId: string | null
  context?: { used: number; limit: number }
}

export interface LeaderRunner {
  run(request: LeaderTurnRequest): Promise<LeaderReply>
  stop(): Promise<void>
}

export const LEADER_DISALLOWED_CLAUDE_TOOLS = ['Agent', 'Task']
