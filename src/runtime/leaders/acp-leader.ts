// Uses the Agent Client Protocol TypeScript SDK: https://github.com/agentclientprotocol/typescript-sdk

import { createRequire } from 'node:module'
import { Readable, Writable } from 'node:stream'

import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { ClientContext, McpServer, SessionConfigOption, StopReason, SystemPrompt } from '@agentclientprotocol/sdk'

import type { Engine } from '../../contracts/engines.js'
import { MOXY_MCP_NAME } from '../../contracts/mcp.js'
import { errorText } from '../../errors.js'
import { exec as defaultExec, spawnPiped } from '../../exec.js'
import type { Exec, SpawnPiped } from '../../exec.js'
import { LEADER_PROMPT } from './leader.js'
import type { LeaderReply, LeaderRunner, LeaderTurnRequest, McpEndpoint } from './leader.js'

export type AcpCommand = { command: string; args: readonly string[]; env?: Record<string, string> }

const require = createRequire(import.meta.url)

export const ACP_LEADER_COMMANDS = {
  codex: (): AcpCommand => ({
    command: process.execPath,
    args: [require.resolve('@agentclientprotocol/codex-acp/dist/index.js')],
    env: { NO_BROWSER: '1' },
  }),
  agy: (): AcpCommand => ({ command: 'agy', args: ['acp'] }),
  kimi: (): AcpCommand => ({ command: 'kimi', args: ['acp'] }),
  deepseek: (): AcpCommand => ({ command: 'dsh', args: ['--profile', 'acp'] }),
} satisfies Partial<Record<Engine, () => AcpCommand>>

export type AcpLeaderEngine = keyof typeof ACP_LEADER_COMMANDS

export function isAcpLeaderEngine(engine: Engine): engine is AcpLeaderEngine {
  return Object.hasOwn(ACP_LEADER_COMMANDS, engine)
}

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

export type AcpLeaderOptions = {
  spawn?: SpawnPiped
  exec?: Exec
  stopGraceMs?: number
}

type RunningTurn = { cancel: () => Promise<void>; kill: () => void; done: Promise<unknown> }

const STOP_GRACE_MS = 3000

export class AcpLeader implements LeaderRunner {
  private running: RunningTurn | null = null

  constructor(
    private readonly agent: AcpCommand,
    private readonly options: AcpLeaderOptions = {},
  ) {}

  async run(request: LeaderTurnRequest): Promise<LeaderReply> {
    const child = (this.options.spawn ?? spawnPiped)(this.agent.command, this.agent.args, {
      cwd: request.cwd,
      ...(this.agent.env ? { env: this.agent.env } : {}),
    })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-4000)))
    child.stdin.on('error', () => undefined)
    const exited = new Promise<number | null>(resolve => {
      child.on('close', code => resolve(code))
      child.on('error', () => resolve(null))
    })
    const spawnFailed = new Promise<never>((_, reject) => child.on('error', reject))
    spawnFailed.catch(() => undefined)
    const kill = () => {
      if (child.exitCode !== null) return
      if (process.platform === 'win32' && child.pid !== undefined) {
        void (this.options.exec ?? defaultExec)('taskkill', ['/PID', String(child.pid), '/T', '/F']).catch(() => undefined)
      } else child.kill()
    }

    let sessionId: string | null = null
    let output = ''
    let replying = false
    let startsNewParagraph = false
    const app = client({ name: 'moxy' })
      .onNotification('session/update', ({ params }) => {
        const update = params.update
        if (!replying || params.sessionId !== sessionId) return
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

    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>)
    let cancel: () => Promise<void> = async () => kill()
    const turn = app.connectWith(stream, async agent => {
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
      const text = takesSystemPrompt || opened.loaded ? request.message : `${LEADER_PROMPT}\n\n${request.message}`
      const response = await agent.request('session/prompt', { sessionId: opened.sessionId, prompt: [{ type: 'text', text }] })
      return response.stopReason
    })

    const running: RunningTurn = { cancel: () => cancel(), kill, done: turn.catch(() => undefined) }
    this.running = running
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const stopReason = await Promise.race([
        turn,
        spawnFailed,
        exited.then(code => {
          throw new Error(`${this.agent.command} exited (${code ?? 'signal'}) during the turn${stderr ? `: ${lastLine(stderr)}` : ''}`)
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`no reply within ${Math.round(request.timeoutMs / 60_000)} minutes`)),
            request.timeoutMs,
          )
        }),
      ])
      return { output, error: stopError(stopReason), nativeSessionId: sessionId }
    } catch (error) {
      return { output, error: errorText(error), nativeSessionId: sessionId }
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
    await agent.request('session/set_config_option', { sessionId, configId: option.id, value })
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

const lastLine = (text: string) => text.trim().split(/\r?\n/).pop() ?? ''
