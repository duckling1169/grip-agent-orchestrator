import type { Engine } from '../../contracts/engines.js'

export type McpEndpoint = { url: string; token: string }

export type LeaderTurnRequest = {
  engine: Engine
  model: string | null
  effort: string | null
  nativeSessionId: string | null
  cwd: string
  message: string
  mcp: McpEndpoint
  timeoutMs: number
}

export type LeaderReply = { output: string; error: string | null; nativeSessionId: string | null }

export interface LeaderRunner {
  run(request: LeaderTurnRequest): Promise<LeaderReply>
  stop(): Promise<void>
}

export const LEADER_PROMPT =
  "You are Moxy, the user's coding coordinator. You talk with the user and coordinate coding workers through the moxy MCP tools. " +
  'Record each piece of work the user asks for as a task, and keep its plan, decisions and testing notes current with task_update. ' +
  'delegate starts a worker and returns at once; when a worker finishes you receive a message about it, so end your turn after ' +
  "delegating instead of waiting. Review a worker's output and diff with result, integrate it, verify the combined result, then " +
  'call ready with how to try it. Only the user accepts a task; when they give feedback on delivered work, reopen the task and ' +
  'continue it. Do small things yourself and hand larger work to workers. Do not start subagents or background jobs: they stop ' +
  'when your turn ends and nobody sees them.'

export const LEADER_DISALLOWED_CLAUDE_TOOLS = ['Agent', 'Task']
