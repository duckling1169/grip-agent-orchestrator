import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { readJsonBody, sendJson as send } from '../http-util.js'
import type { Quota } from '../quota/quota.js'
import type { RunManager } from '../runs/manager.js'
import { createGripMcpServer } from './tools.js'

export const DEFAULT_MCP_PORT = 18797

export type McpHttpOptions = { manager: RunManager; quota: Quota; token: string; port?: number; version?: string }

/**
 * Grip's MCP endpoint for orchestrators: Streamable HTTP at `http://127.0.0.1:<port>/mcp`,
 * loopback only, never published through `tailscale serve`. Every request needs the bearer token
 * from `~/.grip/mcp-token`, and the Host header must be loopback, so neither another local
 * process nor a web page (DNS rebinding) can drive it.
 */
export async function startMcpHttp(options: McpHttpOptions): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const expected = Buffer.from(`Bearer ${options.token}`)
  const server = createServer((req, res) => {
    handle(req, res).catch(error => {
      if (!res.headersSent) send(res, 500, { error: (error as Error).message })
      else res.destroy()
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/mcp') return send(res, 404, { error: 'not found' })
    if (!loopbackHost(req.headers.host)) return send(res, 403, { error: 'Host must be loopback' })
    const given = Buffer.from(req.headers.authorization ?? '')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return send(res, 401, { error: 'Unauthorized' })
    // Stateless: no MCP sessions to keep, so GET (server-to-client streams) has nothing to offer.
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })

    const body = await readJsonBody(req)
    const mcp = createGripMcpServer(options.manager, options.quota, options.version)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void mcp.close()
    })
    await mcp.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? DEFAULT_MCP_PORT, '127.0.0.1', () => resolve())
  })
  // wait_any holds a request open for up to ten minutes.
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  return {
    server,
    port: (server.address() as AddressInfo).port,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

function loopbackHost(host: string | undefined): boolean {
  if (!host) return false
  const name = host.replace(/:\d+$/, '').toLowerCase()
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}
