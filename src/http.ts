import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

const MAX_BODY_BYTES = 1024 * 1024

export type LoopbackServer = { port: number; close(): Promise<void> }

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
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

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false
  try {
    const url = new URL(`http://${host}`)
    return url.host === host.toLowerCase() && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

function hasBearer(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const given = Buffer.from(header.slice('Bearer '.length))
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export function refuseUnlessLocal(req: IncomingMessage, res: ServerResponse, token: string): boolean {
  if (!isLoopbackHost(req.headers.host)) {
    sendJson(res, 403, { error: 'Host must be loopback' })
    return true
  }
  if (req.headers.origin !== undefined && req.headers.origin !== `http://${req.headers.host}`) {
    sendJson(res, 403, { error: 'Origin must match the host' })
    return true
  }
  if (!hasBearer(req.headers.authorization, token)) {
    sendJson(res, 401, { error: 'Unauthorized' })
    return true
  }
  return false
}

export async function listenOnLoopback(
  port: number,
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<LoopbackServer & { server: Server }> {
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
      else res.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return {
    server,
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}
