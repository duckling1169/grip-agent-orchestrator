import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { GRIP_TOOLS, PERMISSION_MODE } from '../runs/manager.js'
import type { ClawApi } from '../runs/manager.js'
import type { Chat } from './store.js'

/**
 * A hosted chat's turn ends when Claude replies, and Grip then stops the session, so a subagent or
 * plugin job Claude starts itself dies with it and the app never sees it. Hosted chats therefore
 * cannot use Claude's own Agent tool, and are told to hand work off through Grip instead.
 */
export const HOSTED_CHAT_DISALLOWED = ['Agent', 'Task']
export const HOSTED_CHAT_PROMPT =
  'You are running inside Grip. To hand work to another agent (Claude, Codex or Antigravity), use the ' +
  "Grip MCP tools (delegate, then wait_any or result). Do not start subagents or background jobs yourself: they stop when your turn ends and the user can't see them. Do the work yourself only when it is small."

/** One turn of a Grip chat, as its leader ran it. */
export type TurnResult = {
  output: string
  error: string | null
  /** The leader's own conversation id, to resume the conversation on the next turn. */
  sessionId: string | null
}

export type TurnInput = {
  chat: Chat
  message: string
  /** Grip's MCP for this chat: its URL and the chat's own token. */
  mcp: { url: string; token: string }
  /** The chat's folder for Grip's files, such as an MCP config. */
  chatDir: string
  timeoutMs: number
  /** True once you stopped the chat, so a turn that has not begun yet does not. */
  /** Current assistant reply as ACP text arrives; excludes thoughts and replayed history. */
  onOutput?: (output: string) => void
  stopped: () => boolean
}

/**
 * How a chat's leader runs a turn (design §5.1). Each turn starts the leader, resumes its
 * conversation, sends the message and ends it again, so nothing it starts outlives the turn.
 */
export interface ChatTurns {
  run(input: TurnInput): Promise<TurnResult>
  /** End the chat's current turn. False when it could not be confirmed. */
  stop(chat: Chat): Promise<boolean>
  /** After Grip restarts: end any turn a previous Grip left running. */
  recover(): Promise<void>
}

/** Claude leads through Claw, which gives it Grip's MCP with `--mcp-config`. */
export class ClawChatTurns implements ChatTurns {
  constructor(
    private readonly claw: ClawApi,
    private readonly clawReady?: () => Promise<void>,
  ) {}

  async run({ chat, message, mcp, chatDir, timeoutMs, stopped }: TurnInput): Promise<TurnResult> {
    const session = chat.session!
    try {
      await this.clawReady?.()
      if (stopped()) throw new Error('stopped before the turn began')
      const mcpConfig = join(chatDir, 'mcp.json')
      await writeMcpConfig(mcpConfig, mcp)
      await this.claw.startSession({
        name: session,
        cwd: chat.folder!,
        engine: 'claude',
        permissionMode: PERMISSION_MODE.claude,
        ...(chat.model ? { model: chat.model } : {}),
        ...(chat.effort ? { effort: chat.effort } : {}),
        ...(chat.engineSessionId ? { resumeSessionId: chat.engineSessionId } : {}),
        mcpConfig,
        allowedTools: [GRIP_TOOLS],
        disallowedTools: HOSTED_CHAT_DISALLOWED,
        appendSystemPrompt: HOSTED_CHAT_PROMPT,
      })
      if (stopped()) throw new Error('stopped before the turn began')
      const sent = await this.claw.sendMessage(session, message, { timeoutMs, ...(chat.effort ? { effort: chat.effort } : {}) })
      const denied = sent.permissionDenials?.length
        ? `\n\n[grip] ${sent.permissionDenials.length} tool call(s) were denied: ${sent.permissionDenials.map(d => d.toolName).join(', ')}`
        : ''
      return { output: sent.output + denied, error: sent.error ?? null, sessionId: sent.sessionId ?? null }
    } finally {
      await this.claw.stopSession(session).catch(() => undefined)
    }
  }

  async stop(chat: Chat): Promise<boolean> {
    if (!chat.session) return true
    return this.claw.stopSession(chat.session).then(
      () => true,
      () => false,
    )
  }

  async recover(): Promise<void> {
    const sessions = await this.claw.listSessions().catch(() => [])
    for (const session of sessions) if (session.name.startsWith('grip-c-')) await this.claw.stopSession(session.name).catch(() => undefined)
  }
}

async function writeMcpConfig(path: string, mcp: TurnInput['mcp']): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({ mcpServers: { grip: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } }),
  )
}
