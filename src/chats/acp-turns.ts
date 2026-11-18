import { Readable, Writable } from 'node:stream'

import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { ClientContext, McpServer, SessionConfigOption, StopReason, SystemPrompt } from '@agentclientprotocol/sdk'

import { errorText } from '../errors.js'
import { exec as defaultExec, spawnPiped } from '../exec.js'
import type { Exec, SpawnPiped } from '../exec.js'
import type { Chat } from './store.js'
import { HOSTED_CHAT_PROMPT } from './turns.js'
import type { ChatTurns, TurnInput, TurnResult } from './turns.js'

/** How to start an agent that serves ACP on stdio, such as `agy acp`. */
export type AcpCommand = { command: string; args: readonly string[]; env?: Record<string, string> }

/**
 * Grip's MCP as a stdio server, for an agent that takes no HTTP MCP servers. The token goes in
 * the bridge's environment, never in its arguments.
 */
export type StdioBridge = (mcp: TurnInput['mcp']) => McpServer

type Options = {
  spawn?: SpawnPiped
  exec?: Exec
  bridge?: StdioBridge
  /** How long a stopped turn may take to wind down before its agent is killed. */
  stopGraceMs?: number
}

type Running = { cancel: () => Promise<void>; kill: () => void; done: Promise<unknown> }

const STOP_GRACE_MS = 3000

/**
 * A leader that Grip runs over ACP itself (design §5.1), because Claw can't give it Grip's MCP.
 * Each turn starts the agent, opens or loads the chat's ACP session with Grip's MCP, sends the
 * message and ends the agent again, like a Claw turn.
 */
export class AcpChatTurns implements ChatTurns {
  private readonly running = new Map<string, Running>()

  constructor(
    private readonly agent: AcpCommand,
    private readonly o: Options = {},
  ) {}

  async run({ chat, message, mcp, timeoutMs, stopped }: TurnInput): Promise<TurnResult> {
    if (stopped()) throw new Error('stopped before the turn began')
    const child = (this.o.spawn ?? spawnPiped)(this.agent.command, this.agent.args, {
      cwd: chat.folder!,
      ...(this.agent.env ? { env: this.agent.env } : {}),
    })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-4000)))
    child.stdin.on('error', () => undefined)
    const exited = new Promise<number | null>(resolve => {
      child.on('close', code => resolve(code))
      child.on('error', () => resolve(null))
    })
    const spawnFailed = new Promise<never>((_, reject) => child.on('error', error => reject(error)))
    spawnFailed.catch(() => undefined)
    // An adapter such as codex-acp starts the engine as its own child, so end the whole tree.
    const kill = () => {
      if (child.exitCode !== null) return
      if (process.platform === 'win32' && child.pid !== undefined)
        void (this.o.exec ?? defaultExec)('taskkill', ['/PID', String(child.pid), '/T', '/F']).catch(() => undefined)
      else child.kill()
    }

    let sessionId: string | null = null
    let output = ''
    // A loaded session replays its history as updates; only the reply to this turn counts.
    let replying = false
    // A leader writes a message, calls tools, then writes another; each message starts a paragraph.
    let paragraph = false
    const app = client({ name: 'grip' })
      .onNotification('session/update', ({ params }) => {
        const update = params.update
        if (!replying || params.sessionId !== sessionId) return
        if (update.sessionUpdate !== 'agent_message_chunk') {
          paragraph = output.length > 0
          return
        }
        if (update.content.type !== 'text') return
        output += (paragraph ? '\n\n' : '') + update.content.text
        paragraph = false
      })
      // A leader works in its chat's folder, as a Claude chat does in its permission mode.
      .onRequest('session/request_permission', ({ params }) => {
        const allow = params.options.find(o => o.kind === 'allow_once') ?? params.options.find(o => o.kind === 'allow_always')
        return { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } }
      })

    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>)
    let cancel: () => Promise<void> = async () => kill()
    const turn = app.connectWith(stream, async agent => {
      const init = await agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const server = this.grip(mcp, init.agentCapabilities?.mcpCapabilities?.http === true)
      const systemPrompt = Boolean(init.agentCapabilities?.sessionCapabilities?.systemPrompt)
      const opened = await openSession(agent, chat, server, { load: init.agentCapabilities?.loadSession === true, systemPrompt })
      sessionId = opened.sessionId
      cancel = async () => {
        await agent.notify('session/cancel', { sessionId: opened.sessionId }).catch(() => undefined)
      }
      await configure(agent, opened.sessionId, opened.configOptions, chat)
      if (stopped()) throw new Error('stopped before the turn began')
      replying = true
      // Without a system prompt, a new conversation learns how Grip works from its first message,
      // and a loaded one already has it.
      const text = systemPrompt || opened.loaded ? message : `${HOSTED_CHAT_PROMPT}\n\n${message}`
      const response = await agent.request('session/prompt', { sessionId: opened.sessionId, prompt: [{ type: 'text', text }] })
      return response.stopReason
    })

    const running: Running = { cancel: () => cancel(), kill, done: turn.catch(() => undefined) }
    this.running.set(chat.id, running)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const stopReason = await Promise.race([
        turn,
        spawnFailed,
        exited.then(code => {
          throw new Error(`${this.agent.command} exited (${code ?? 'signal'}) during the turn${stderr ? `: ${lastLine(stderr)}` : ''}`)
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no reply within ${Math.round(timeoutMs / 60_000)} minutes`)), timeoutMs)
        }),
      ])
      return { output, error: stopError(stopReason), sessionId }
    } catch (error) {
      return { output, error: errorText(error), sessionId }
    } finally {
      if (timer) clearTimeout(timer)
      if (this.running.get(chat.id) === running) this.running.delete(chat.id)
      kill()
    }
  }

  async stop(chat: Chat): Promise<boolean> {
    const running = this.running.get(chat.id)
    if (!running) return true
    await running.cancel()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      running.done,
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, this.o.stopGraceMs ?? STOP_GRACE_MS)
      }),
    ])
    if (timer) clearTimeout(timer)
    // Grip owns the agent's process, so a turn that did not wind down is simply ended.
    running.kill()
    return true
  }

  /** A leader's agent is Grip's own child process, so nothing outlives a Grip restart to end. */
  async recover(): Promise<void> {}

  private grip(mcp: TurnInput['mcp'], http: boolean): McpServer {
    if (http) return { type: 'http', name: 'grip', url: mcp.url, headers: [{ name: 'Authorization', value: `Bearer ${mcp.token}` }] }
    if (this.o.bridge) return this.o.bridge(mcp)
    throw new Error(`${this.agent.command} takes no HTTP MCP servers, and no stdio bridge is set up`)
  }
}

type Opened = { sessionId: string; configOptions: SessionConfigOption[]; loaded: boolean }

/**
 * Load the chat's earlier conversation when the agent can, else start a new one. Grip's chat
 * prompt goes in as an appended system prompt where the agent takes one, on every load too.
 */
async function openSession(
  agent: ClientContext,
  chat: Chat,
  server: McpServer,
  can: { load: boolean; systemPrompt: boolean },
): Promise<Opened> {
  const cwd = chat.folder!
  const systemPrompt: SystemPrompt | null = can.systemPrompt
    ? { mode: 'append', content: [{ type: 'text', text: HOSTED_CHAT_PROMPT }] }
    : null
  if (chat.engineSessionId && can.load) {
    const loaded = await agent
      .request('session/load', { sessionId: chat.engineSessionId, cwd, mcpServers: [server], systemPrompt: systemPrompt ?? undefined })
      .then(
        response => response,
        () => null,
      )
    if (loaded) return { sessionId: chat.engineSessionId, configOptions: loaded.configOptions ?? [], loaded: true }
  }
  const created = await agent.request('session/new', { cwd, mcpServers: [server], systemPrompt: systemPrompt ?? undefined })
  return { sessionId: created.sessionId, configOptions: created.configOptions ?? [], loaded: false }
}

/** Pick the chat's model and effort through the agent's own session options, where it has them. */
async function configure(agent: ClientContext, sessionId: string, options: SessionConfigOption[], chat: Chat): Promise<void> {
  const choose = async (category: string, value: string | null) => {
    const option = options.find(o => o.category === category && o.type === 'select')
    if (!value || !option || option.type !== 'select' || option.currentValue === value) return
    const values = option.options.flatMap(o => ('options' in o ? o.options : [o])).map(o => o.value)
    if (!values.includes(value)) throw new Error(`${chat.engine} has no ${category} "${value}"; it offers ${values.join(', ')}`)
    await agent.request('session/set_config_option', { sessionId, configId: option.id, value })
  }
  await choose('model', chat.model)
  await choose('thought_level', chat.effort)
}

function stopError(reason: StopReason): string | null {
  switch (reason) {
    case 'end_turn':
      return null
    case 'cancelled':
      return 'stopped'
    case 'refusal':
      return 'the model refused to continue'
    case 'max_tokens':
      return 'the reply reached its token limit'
    case 'max_turn_requests':
      return 'the turn reached its limit of model requests'
  }
}

const lastLine = (text: string) => text.trim().split(/\r?\n/).pop() ?? ''
