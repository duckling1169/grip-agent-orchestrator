import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Readable, Writable } from 'node:stream'

import { agent, ndJsonStream } from '@agentclientprotocol/sdk'
import type { McpServer, RequestPermissionOutcome, SessionConfigOption } from '@agentclientprotocol/sdk'

import type { SpawnPiped } from '../exec.js'

export type FakeAcpOptions = {
  /** Advertise HTTP MCP servers. */
  http?: boolean
  loadSession?: boolean
  configOptions?: SessionConfigOption[]
  /** The reply, sent as two chunks. */
  reply?: string
  /** Ask for permission once before replying. */
  askPermission?: boolean
  /** Hold the reply until the turn is cancelled. */
  hang?: boolean
}

/** What the fake agent was asked, for tests to check. */
export type FakeAcpLog = {
  spawned: { command: string; args: readonly string[]; cwd?: string }[]
  newSessions: { cwd: string; mcpServers: McpServer[] }[]
  loads: { sessionId: string; mcpServers: McpServer[] }[]
  prompts: { sessionId: string; text: string }[]
  configs: { configId: string; value: unknown }[]
  permission: RequestPermissionOutcome | null
  cancelled: number
  killed: number
}

/**
 * A stand-in for an agent that serves ACP on stdio (`agy acp`, `codex-acp`), built on the SDK's
 * agent side and run in-process, so tests never start a real agent or call a model.
 */
export function fakeAcpAgent(options: FakeAcpOptions = {}): { spawn: SpawnPiped; log: FakeAcpLog } {
  const log: FakeAcpLog = { spawned: [], newSessions: [], loads: [], prompts: [], configs: [], permission: null, cancelled: 0, killed: 0 }
  let sessions = 0

  const spawn: SpawnPiped = (command, args, spawnOptions = {}) => {
    log.spawned.push({ command, args, ...(spawnOptions.cwd ? { cwd: spawnOptions.cwd } : {}) })
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      pid: undefined,
      exitCode: null as number | null,
      kill: () => {
        if (child.exitCode !== null) return true
        log.killed++
        child.exitCode = 0
        stdout.end()
        setImmediate(() => child.emit('close', 0))
        return true
      },
    })

    const cancels = new Set<() => void>()
    const app = agent({ name: 'fake-acp' })
      .onRequest('initialize', ({ params }) => ({
        protocolVersion: params.protocolVersion,
        agentCapabilities: { loadSession: options.loadSession ?? false, mcpCapabilities: { http: options.http ?? false } },
      }))
      .onRequest('session/new', ({ params }) => {
        log.newSessions.push({ cwd: params.cwd, mcpServers: params.mcpServers })
        return { sessionId: `fake-${++sessions}`, configOptions: options.configOptions ?? [] }
      })
      .onRequest('session/load', async ({ params, client }) => {
        log.loads.push({ sessionId: params.sessionId, mcpServers: params.mcpServers })
        // A load replays the conversation so far, which is not part of the next reply.
        await client.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Earlier reply. ' } },
        })
        return { configOptions: options.configOptions ?? [] }
      })
      .onRequest('session/set_config_option', ({ params }) => {
        log.configs.push({ configId: params.configId, value: params.value })
        return { configOptions: options.configOptions ?? [] }
      })
      .onNotification('session/cancel', () => {
        log.cancelled++
        for (const cancel of cancels) cancel()
      })
      .onRequest('session/prompt', async ({ params, client }) => {
        const text = params.prompt.map(block => (block.type === 'text' ? block.text : '')).join('')
        log.prompts.push({ sessionId: params.sessionId, text })
        if (options.askPermission) {
          const answer = await client.request('session/request_permission', {
            sessionId: params.sessionId,
            toolCall: { toolCallId: 'edit-1', title: 'Edit a file' },
            options: [
              { optionId: 'no', name: 'Reject', kind: 'reject_once' },
              { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
            ],
          })
          log.permission = answer.outcome
        }
        if (options.hang) {
          await new Promise<void>(resolve => cancels.add(resolve))
          return { stopReason: 'cancelled' }
        }
        const reply = options.reply ?? 'Done.'
        const half = Math.ceil(reply.length / 2)
        for (const part of [reply.slice(0, half), reply.slice(half)])
          await client.notify('session/update', {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part } },
          })
        return { stopReason: 'end_turn' }
      })
    app.connect(ndJsonStream(Writable.toWeb(stdout), Readable.toWeb(stdin) as ReadableStream<Uint8Array>))
    return child as unknown as ChildProcessWithoutNullStreams
  }

  return { spawn, log }
}
