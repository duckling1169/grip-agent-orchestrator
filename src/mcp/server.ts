// Stateless Streamable HTTP handling follows the official MCP TypeScript SDK v1.x examples:
// https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/examples/server/simpleStatelessStreamableHttp.ts

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { listenOnLoopback, readJsonBody, refuseUnlessLocal, sendJson } from '../http.js'
import type { LoopbackServer } from '../http.js'
import type { Workers } from '../workers/service.js'
import { createLeaderMcpServer } from './tools.js'

export const DEFAULT_MCP_PORT = 18797

export type McpServerOptions = { workers: Workers; token: string; port: number; version: string }

export function startMcpServer(options: McpServerOptions): Promise<LoopbackServer> {
  return listenOnLoopback(options.port, async (req, res) => {
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/mcp') return sendJson(res, 404, { error: 'not found' })
    if (refuseUnlessLocal(req, res, options.token)) return
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })
    }
    const body = await readJsonBody(req)
    const server = createLeaderMcpServer(options.workers, options.version)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  })
}
