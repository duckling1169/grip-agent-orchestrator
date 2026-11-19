// Uses the Agent Client Protocol TypeScript SDK: https://github.com/agentclientprotocol/typescript-sdk

import { createRequire } from 'node:module'

import { client, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { ClientContext, McpServer, SessionConfigOption, StopReason, SystemPrompt } from '@agentclientprotocol/sdk'

import { MOXY_MCP_NAME } from '../../contracts/mcp.js'
import { errorText } from '../../errors.js'
import { startAcpProcess } from '../acp-process.js'
import type { AcpCommand, AcpProcessOptions } from '../acp-process.js'
import { LEADER_PROMPT } from './leader.js'
import type { LeaderReply, LeaderRunner, LeaderTurnRequest, McpEndpoint } from './leader.js'

const require = createRequire(import.meta.url)

const BRIDGE_AUTHORIZATION_ENV = 'MOXY_AUTHORIZATION'

export function mcpRemoteBridge(mcp: McpEndpoint): McpServer {
  return {
    name: MOXY_MCP_NAME,
    command: process.execPath,
    args: [
      require.resolve('mcp-remote/dist/proxy.js'),
      mcp.url,
      '--transport',
      'http-only',
      '--header',
      `Authorization:\${${BRIDGE_AUTHORIZATION_ENV}}`,
    ],
    env: [{ name: BRIDGE_AUTHORIZATION_ENV, value: `Bearer ${mcp.token}` }],
  }
}

export type AcpLeaderOptions = AcpProcessOptions & { stopGraceMs?: number }

type RunningTurn = { cancel: () => Promise<void>; kill: () => void; done: Promise<unknown> }

const STOP_GRACE_MS = 3000

export class AcpLeader implements LeaderRunner {
  private running: RunningTurn | null = null

  constructor(
    private readonly agent: AcpCommand,
    private readonly options: AcpLeaderOptions = {},
  ) {}

  async run(request: LeaderTurnRequest): Promise<LeaderReply> {
    const agentProcess = startAcpProcess(this.agent, request.cwd, this.options)
    const { kill } = agentProcess

    let sessionId: string | null = null
    let output = ''
    let context: LeaderReply['context']
    let replying = false
    let startsNewParagraph = false
    const app = client({ name: 'moxy' })
      .onNotification('session/update', ({ params }) => {
        const update = params.update
        if (!replying || params.sessionId !== sessionId) return
        if (update.sessionUpdate === 'usage_update') {
          if (Number.isFinite(update.used) && update.used >= 0 && Number.isFinite(update.size) && update.size > 0)
            context = { used: update.used, limit: update.size }
          return
        }
        if (update.sessionUpdate !== 'agent_message_chunk') {
          startsNewParagraph = output.length > 0
          return
        }
        if (update.content.type !== 'text') return
        output += (startsNewParagraph ? '\n\n' : '') + update.content.text
        startsNewParagraph = false
      })
      .onRequest('session/request_permission', ({ params }) => {
        const allow =
          params.options.find(option => option.kind === 'allow_once') ?? params.options.find(option => option.kind === 'allow_always')
        return { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } }
      })

    let cancel: () => Promise<void> = async () => kill()
    const turn = app.connectWith(agentProcess.stream, async agent => {
      const init = await agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const server = moxyServer(request.mcp, init.agentCapabilities?.mcpCapabilities?.http === true)
      const takesSystemPrompt = Boolean(init.agentCapabilities?.sessionCapabilities?.systemPrompt)
      const opened = await openSession(agent, request, server, {
        load: init.agentCapabilities?.loadSession === true,
        systemPrompt: takesSystemPrompt,
      })
      sessionId = opened.sessionId
      cancel = async () => {
        await agent.notify('session/cancel', { sessionId: opened.sessionId }).catch(() => undefined)
      }
      await configure(agent, opened.sessionId, opened.configOptions, request)
      replying = true
      const message =
        request.nativeSessionId && !opened.loaded && request.freshContext
          ? `${request.freshContext}\n\n${request.message}`
          : request.message
      const text = takesSystemPrompt || opened.loaded ? message : `${LEADER_PROMPT}\n\n${message}`
      const response = await agent.request('session/prompt', { sessionId: opened.sessionId, prompt: [{ type: 'text', text }] })
      return response.stopReason
    })

    const running: RunningTurn = { cancel: () => cancel(), kill, done: turn.catch(() => undefined) }
    this.running = running
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const stopReason = await Promise.race([
        turn,
        agentProcess.failed('during the turn'),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`no reply within ${Math.round(request.timeoutMs / 60_000)} minutes`)),
            request.timeoutMs,
          )
        }),
      ])
      return { output, error: stopError(stopReason), nativeSessionId: sessionId, ...(context ? { context } : {}) }
    } catch (error) {
      return { output, error: errorText(error), nativeSessionId: sessionId, ...(context ? { context } : {}) }
    } finally {
      if (timer) clearTimeout(timer)
      if (this.running === running) this.running = null
      kill()
    }
  }

  async stop(): Promise<void> {
    const running = this.running
    if (!running) return
    await running.cancel()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      running.done,
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, this.options.stopGraceMs ?? STOP_GRACE_MS)
      }),
    ])
    if (timer) clearTimeout(timer)
    running.kill()
  }
}

function moxyServer(mcp: McpEndpoint, takesHttp: boolean): McpServer {
  if (takesHttp) {
    return { type: 'http', name: MOXY_MCP_NAME, url: mcp.url, headers: [{ name: 'Authorization', value: `Bearer ${mcp.token}` }] }
  }
  return mcpRemoteBridge(mcp)
}

type OpenedSession = { sessionId: string; configOptions: SessionConfigOption[]; loaded: boolean }

async function openSession(
  agent: ClientContext,
  request: LeaderTurnRequest,
  server: McpServer,
  can: { load: boolean; systemPrompt: boolean },
): Promise<OpenedSession> {
  const systemPrompt: SystemPrompt | undefined = can.systemPrompt
    ? { mode: 'append', content: [{ type: 'text', text: LEADER_PROMPT }] }
    : undefined
  if (request.nativeSessionId && can.load) {
    const loaded = await agent
      .request('session/load', { sessionId: request.nativeSessionId, cwd: request.cwd, mcpServers: [server], systemPrompt })
      .catch(() => null)
    if (loaded) return { sessionId: request.nativeSessionId, configOptions: loaded.configOptions ?? [], loaded: true }
  }
  const created = await agent.request('session/new', { cwd: request.cwd, mcpServers: [server], systemPrompt })
  return { sessionId: created.sessionId, configOptions: created.configOptions ?? [], loaded: false }
}

async function configure(
  agent: ClientContext,
  sessionId: string,
  options: SessionConfigOption[],
  request: LeaderTurnRequest,
): Promise<void> {
  const choose = async (category: string, value: string | null) => {
    const option = options.find(candidate => candidate.category === category && candidate.type === 'select')
    if (!value || !option || option.type !== 'select' || option.currentValue === value) return
    const values = option.options.flatMap(choice => ('options' in choice ? choice.options : [choice])).map(choice => choice.value)
    if (!values.includes(value)) throw new Error(`${request.engine} has no ${category} "${value}"; it offers ${values.join(', ')}`)
    options = (await agent.request('session/set_config_option', { sessionId, configId: option.id, value })).configOptions
  }
  await choose('model', request.model)
  await choose('thought_level', request.effort)
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
