import { createRequire } from 'node:module'
import { Readable, Writable } from 'node:stream'

import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

import { errorText } from '../errors.js'
import { spawnPiped } from '../exec.js'
import type { Exec, SpawnPiped } from '../exec.js'
import type { Engine } from '../runs/store.js'
import { AcpChatTurns } from './acp-turns.js'
import type { AcpCommand, StdioBridge } from './acp-turns.js'
import type { ChatTurns } from './turns.js'

const require = createRequire(import.meta.url)

/** Leaders Grip runs over ACP (design §5.1). Claude leads through Claw instead. */
export const ACP_LEADERS = {
  /** Codex through the ACP project's adapter, which runs Codex's own app-server and shares its login. */
  codex: (): AcpCommand => ({
    command: process.execPath,
    args: [require.resolve('@agentclientprotocol/codex-acp/dist/index.js')],
    // Grip has no browser to offer for a sign-in; Codex is signed in once with `codex login`.
    env: { NO_BROWSER: '1' },
  }),
  agy: (): AcpCommand => ({ command: 'agy', args: ['acp'] }),
} satisfies Partial<Record<Engine, () => AcpCommand>>

const BRIDGE_AUTH_ENV = 'GRIP_AUTHORIZATION'

/**
 * Grip's MCP as a stdio server through `mcp-remote`, for leaders that take no HTTP MCP servers
 * (agy). `mcp-remote` expands `${…}` in its header from its own environment, so the chat's token
 * never appears in a process's arguments.
 */
export const mcpRemoteBridge: StdioBridge = mcp => ({
  name: 'grip',
  command: process.execPath,
  args: [
    require.resolve('mcp-remote/dist/proxy.js'),
    mcp.url,
    '--transport',
    'http-only',
    '--header',
    `Authorization:\${${BRIDGE_AUTH_ENV}}`,
  ],
  env: [{ name: BRIDGE_AUTH_ENV, value: `Bearer ${mcp.token}` }],
})

export function acpLeaders(options: { spawn?: SpawnPiped; exec?: Exec } = {}): Partial<Record<Engine, ChatTurns>> {
  return {
    codex: new AcpChatTurns(ACP_LEADERS.codex(), { ...options, bridge: mcpRemoteBridge }),
    agy: new AcpChatTurns(ACP_LEADERS.agy(), { ...options, bridge: mcpRemoteBridge }),
  }
}

export type LeaderCheck = { available: true } | { available: false; reason: string }

const PROBE_MS = 20_000

/**
 * Whether a leader can start: its command runs and answers ACP's `initialize`. No session is
 * opened, so no model turn is spent.
 */
export async function probeLeader(agent: AcpCommand, spawn: SpawnPiped = spawnPiped, timeoutMs = PROBE_MS): Promise<LeaderCheck> {
  let child: ReturnType<SpawnPiped>
  try {
    child = spawn(agent.command, agent.args, agent.env ? { env: agent.env } : {})
  } catch (error) {
    return { available: false, reason: errorText(error) }
  }
  child.stdin.on('error', () => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>)
    await Promise.race([
      client({ name: 'grip' }).connectWith(stream, agent =>
        agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
      ),
      new Promise<never>((_, reject) => child.on('error', reject)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000} s`)), timeoutMs)
      }),
    ])
    return { available: true }
  } catch (error) {
    const reason = errorText(error)
    return { available: false, reason: /ENOENT/.test(reason) ? `${agent.command} is not installed` : reason }
  } finally {
    if (timer) clearTimeout(timer)
    child.kill()
  }
}
