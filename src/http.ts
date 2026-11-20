import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

const MAX_BODY_BYTES = 1024 * 1024

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export type LoopbackServer = { port: number; close(): Promise<void> }

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large')
    chunks.push(chunk)
  }
  try {
    return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) : undefined
  } catch {
    throw new HttpError(400, 'request body is not JSON')
  }
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false
  try {
    const url = new URL(`http://${host}`)
    return url.host === host.toLowerCase() && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

export function hasBearer(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
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
