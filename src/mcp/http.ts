import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CancelledNotificationSchema, isInitializeRequest, isJSONRPCRequest } from '@modelcontextprotocol/sdk/types.js'
import type { RequestId } from '@modelcontextprotocol/sdk/types.js'

import type { ChatManager } from '../chats/manager.js'
import { chatOfToken } from '../chats/token.js'
import { readJsonBody, sendJson as send } from '../http-util.js'
import type { Quota } from '../quota/quota.js'
import type { RunManager } from '../runs/manager.js'
import { createGripMcpServer } from './tools.js'
import type { McpModels } from './tools.js'
import type { McpCaller } from './tools.js'
import { DEFAULT_SETTINGS, days } from '../settings.js'

export const DEFAULT_MCP_PORT = 18797

/** Only the chat operations needed by the MCP adapter. */
export type McpChats = Pick<ChatManager, 'externalChat' | 'rename' | 'setWaiting' | 'get'>

export type McpHttpOptions = {
  manager: RunManager
  quota: Quota
  token: string
  chats?: McpChats
  /** Each agent's models, for the `models` tool. */
  models?: McpModels
  port?: number
  version?: string
  /** Bounds in-memory sessions, including those still initializing. */
  maxSessions?: number
  sessionIdleMs?: number
}

type Session = {
  mcp: ReturnType<typeof createGripMcpServer>
  transport: StreamableHTTPServerTransport
  principal: string
  active: number
  lastActive: number
  responses: Map<RequestId, ServerResponse>
}

/**
 * Grip's loopback-only MCP endpoint, never published through tailscale serve. Authentication
 * is checked on every request; a session ID only routes a request, it never grants access.
 * Session lifecycle adapted from the official MCP TypeScript SDK v1.x HTTP examples:
 * https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/examples/server/simpleStreamableHttp.ts
 */
export async function startMcpHttp(options: McpHttpOptions): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  // Each session is one chat (design §5.1). An expired session makes its client start a new one,
  // which shows up as a new chat, so idle sessions live for days rather than minutes.
  const maxSessions = options.maxSessions ?? 512
  const idleMs = options.sessionIdleMs ?? days(DEFAULT_SETTINGS.mcpSessionIdleDays)
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || !Number.isFinite(idleMs) || idleMs < 1)
    throw new Error('MCP session limits must be positive')
  const expected = Buffer.from(options.token)
  const sessions = new Map<string, Session>()
  // Includes sessions awaiting initialization, so parallel initialize requests respect the cap.
  const openSessions = new Set<Session>()
  let closing = false
  let stopping: Promise<void> | undefined
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) mcpError(res, 500, -32603, 'Internal server error')
      else res.destroy()
    })
  })

  function authenticate(header: string | undefined): { principal: string; chatId?: string } | null {
    if (!header?.startsWith('Bearer ')) return null
    const token = header.slice(7)
    const given = Buffer.from(token)
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { principal: 'install' }
    const chatId = chatOfToken(options.token, token)
    if (chatId && options.chats?.get(chatId)?.kind === 'grip') return { principal: `chat:${chatId}`, chatId }
    return null
  }

  function track(session: Session, res: ServerResponse, body: unknown) {
    session.active++
    const id = isJSONRPCRequest(body) ? body.id : undefined
    if (id !== undefined) session.responses.set(id, res)
    res.once('close', () => {
      session.active--
      session.lastActive = Date.now()
      if (id !== undefined && session.responses.get(id) === res) session.responses.delete(id)
    })
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/mcp') return send(res, 404, { error: 'not found' })
    if (!loopbackHost(req.headers.host)) return send(res, 403, { error: 'Host must be loopback' })
    // Native MCP clients need no Origin. Browser requests must come from this endpoint's origin.
    if (req.headers.origin !== undefined && req.headers.origin !== `http://${req.headers.host}`)
      return send(res, 403, { error: 'Origin must match the MCP endpoint' })
    const identity = authenticate(req.headers.authorization)
    if (!identity) return send(res, 401, { error: 'Unauthorized' })
    if (closing) return mcpError(res, 503, -32000, 'Server is shutting down')
    const id = req.headers['mcp-session-id']
    if (Array.isArray(id)) return mcpError(res, 400, -32000, 'Invalid session ID')
    const session = id ? sessions.get(id) : undefined
    if (id && !session) return mcpError(res, 404, -32001, 'Session not found')
    if (session && session.principal !== identity.principal) return send(res, 403, { error: 'Session belongs to another caller' })
    // JSON responses suffice for Grip. No standalone server-to-client SSE stream is offered.
    if (req.method !== 'POST' && req.method !== 'DELETE') {
      res.setHeader('Allow', 'POST, DELETE')
      return mcpError(res, 405, -32000, 'Method not allowed')
    }
    if (req.method === 'DELETE') {
      if (!session) return mcpError(res, 400, -32000, 'Session ID required')
      return session.transport.handleRequest(req, res)
    }
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return mcpError(res, 400, -32700, (error as Error).message)
    }
    // Reading a streamed body can outlive shutdown or expiry of the session checked above.
    if (closing) return mcpError(res, 503, -32000, 'Server is shutting down')
    if (id && sessions.get(id) !== session) return mcpError(res, 404, -32001, 'Session not found')
    if (session) {
      track(session, res, body)
      await session.transport.handleRequest(req, res, body)
      const cancelled = CancelledNotificationSchema.safeParse(body)
      if (cancelled.success && cancelled.data.params.requestId !== undefined && session.responses.has(cancelled.data.params.requestId)) {
        // SDK v1 suppresses canceled handler replies. Finish its JSON response explicitly so
        // the pending POST and its transport bookkeeping are released without ending the session.
        await session.transport.send({
          jsonrpc: '2.0',
          id: cancelled.data.params.requestId,
          error: { code: -32800, message: 'Request cancelled' },
        })
      }
      return
    }
    if (!isInitializeRequest(body)) return mcpError(res, 400, -32000, 'Initialize a session first')
    if (openSessions.size >= maxSessions) return mcpError(res, 503, -32000, 'Too many open sessions')
    const caller: McpCaller = { chats: options.chats, chatId: identity.chatId, host: body.params.clientInfo.name }
    const mcp = createGripMcpServer(options.manager, options.quota, options.version, caller, options.models)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: sessionId => {
        sessions.set(sessionId, created)
      },
    })
    const created: Session = { mcp, transport, principal: identity.principal, active: 0, lastActive: Date.now(), responses: new Map() }
    openSessions.add(created)
    // connect() preserves this handler and also aborts outstanding tool calls on transport close.
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId)
      openSessions.delete(created)
      for (const response of created.responses.values()) response.destroy()
    }
    track(created, res, body)
    try {
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (error) {
      await mcp.close()
      throw error
    } finally {
      if (!transport.sessionId) await mcp.close()
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? DEFAULT_MCP_PORT, '127.0.0.1', () => resolve())
  })
  const sweep = setInterval(
    () => {
      const cutoff = Date.now() - idleMs
      for (const session of openSessions)
        if (session.active === 0 && session.lastActive <= cutoff) void session.mcp.close().catch(() => undefined)
    },
    Math.min(idleMs, 60_000),
  )
  sweep.unref()
  // wait_any holds a request open for up to ten minutes.
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  return {
    server,
    port: (server.address() as AddressInfo).port,
    close: () =>
      (stopping ??= (async () => {
        closing = true
        clearInterval(sweep)
        const closed = new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
        await Promise.allSettled([...openSessions].map(session => session.mcp.close()))
        server.closeAllConnections()
        await closed
      })()),
  }
}

function mcpError(res: ServerResponse, status: number, code: number, message: string) {
  send(res, status, { jsonrpc: '2.0', error: { code, message }, id: null })
}

function loopbackHost(host: string | undefined): boolean {
  if (!host) return false
  try {
    const url = new URL(`http://${host}`)
    return url.host === host.toLowerCase() && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}
