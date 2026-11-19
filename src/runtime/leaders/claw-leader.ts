import { engineSpec } from '../../contracts/engines.js'
import { MOXY_MCP_NAME, MOXY_MCP_TOOLS } from '../../contracts/mcp.js'
import { errorText } from '../../errors.js'
import { writeFileAtomic } from '../../files.js'
import { replyText } from '../claw/client.js'
import type { ClawSessions } from '../claw/client.js'
import { LEADER_DISALLOWED_CLAUDE_TOOLS, LEADER_PROMPT } from './leader.js'
import type { LeaderReply, LeaderRunner, LeaderTurnRequest, McpEndpoint } from './leader.js'

export const LEADER_SESSION = 'moxy-leader'

export class ClawLeader implements LeaderRunner {
  constructor(
    private readonly claw: ClawSessions,
    private readonly mcpConfigPath: string,
  ) {}

  async run(request: LeaderTurnRequest): Promise<LeaderReply> {
    try {
      await writeFileAtomic(this.mcpConfigPath, mcpConfig(request.mcp), 0o600)
      await this.claw.startSession({
        name: LEADER_SESSION,
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
      const sent = await this.claw.sendMessage(LEADER_SESSION, request.message, {
        timeoutMs: request.timeoutMs,
        ...(request.effort ? { effort: request.effort } : {}),
      })
      return { output: replyText(sent), error: sent.error ?? null, nativeSessionId: sent.sessionId ?? null }
    } catch (error) {
      return { output: '', error: errorText(error), nativeSessionId: null }
    } finally {
      await this.claw.stopSession(LEADER_SESSION).catch(() => undefined)
    }
  }

  async stop(): Promise<void> {
    await this.claw.stopSession(LEADER_SESSION).catch(() => undefined)
  }
}

function mcpConfig(mcp: McpEndpoint): string {
  return JSON.stringify({
    mcpServers: { [MOXY_MCP_NAME]: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } },
  })
}
