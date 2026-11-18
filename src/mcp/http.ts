import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import type { RunManager } from '../runs/manager.js'
import { createGripMcpServer } from './tools.js'

export const DEFAULT_MCP_PORT = 18797
const MAX_BODY_BYTES = 1024 * 1024

export type McpHttpOptions = { manager: RunManager; token: string; port?: number; version?: string }

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

    const body = await readJson(req)
    const mcp = createGripMcpServer(options.manager, options.version)
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

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined)
      } catch {
        reject(new Error('request body is not JSON'))
      }
    })
    req.on('error', reject)
  })
}
