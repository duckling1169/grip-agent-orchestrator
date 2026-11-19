import { randomUUID } from 'node:crypto'

import { engineSpec } from '../../contracts/engines.js'
import { MOXY_MCP_NAME, MOXY_MCP_TOOLS } from '../../contracts/mcp.js'
import { errorText } from '../../errors.js'
import { writeFileAtomic } from '../../files.js'
import { replyText } from '../claw/client.js'
import type { ClawSessions } from '../claw/client.js'
import { LEADER_DISALLOWED_CLAUDE_TOOLS, LEADER_PROMPT } from './leader.js'
import type { LeaderReply, LeaderRunner, LeaderTurnRequest, McpEndpoint } from './leader.js'

export const LEADER_SESSION_PREFIX = 'moxy-leader-'

export class ClawLeader implements LeaderRunner {
  private running: { name: string; stopped: boolean } | null = null

  constructor(
    private readonly claw: ClawSessions,
    private readonly mcpConfigPath: string,
  ) {}

  async run(request: LeaderTurnRequest): Promise<LeaderReply> {
    const key = request.sessionKey?.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
    const running = { name: `${LEADER_SESSION_PREFIX}${key ? `${key}-` : ''}${randomUUID()}`, stopped: false }
    this.running = running
    try {
      await writeFileAtomic(this.mcpConfigPath, mcpConfig(request.mcp), 0o600)
      if (running.stopped) return { output: '', error: 'stopped', nativeSessionId: null }
      await this.claw.startSession({
        name: running.name,
        cwd: request.cwd,
        engine: 'claude',
        ...(engineSpec('claude').permissionMode ? { permissionMode: engineSpec('claude').permissionMode } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        ...(request.nativeSessionId ? { resumeSessionId: request.nativeSessionId } : {}),
        mcpConfig: this.mcpConfigPath,
        allowedTools: [MOXY_MCP_TOOLS],
        disallowedTools: LEADER_DISALLOWED_CLAUDE_TOOLS,
        appendSystemPrompt: LEADER_PROMPT,
      })
      if (running.stopped) return { output: '', error: 'stopped', nativeSessionId: null }
      const sent = await this.claw.sendMessage(running.name, request.message, {
        timeoutMs: request.timeoutMs,
        ...(request.effort ? { effort: request.effort } : {}),
      })
      return { output: replyText(sent), error: sent.error ?? null, nativeSessionId: sent.sessionId ?? null }
    } catch (error) {
      return { output: '', error: errorText(error), nativeSessionId: null }
    } finally {
      await this.claw.stopSession(running.name).catch(() => undefined)
      if (this.running === running) this.running = null
    }
  }

  async stop(): Promise<void> {
    const running = this.running
    if (!running) return
    running.stopped = true
    await this.claw.stopSession(running.name).catch(() => undefined)
  }
}

function mcpConfig(mcp: McpEndpoint): string {
  return JSON.stringify({
    mcpServers: { [MOXY_MCP_NAME]: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } },
  })
}
