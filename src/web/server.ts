import { randomUUID } from 'node:crypto'

import { listenOnLoopback, readJsonBody, refuseUnlessLocal, sendJson } from '../http.js'
import type { LoopbackServer } from '../http.js'
import { userMessage } from '../moxy/store.js'
import type { ConversationStore } from '../moxy/store.js'

export const DEFAULT_WEB_PORT = 18798

export type WebServerOptions = { conversation: ConversationStore; wake: () => void; token: string; port: number }

export type PostedMessage = { source: string; received: boolean }

export function startWebServer(options: WebServerOptions): Promise<LoopbackServer> {
  return listenOnLoopback(options.port, async (req, res) => {
    if (refuseUnlessLocal(req, res, options.token)) return
    const route = `${req.method} ${new URL(req.url ?? '/', 'http://127.0.0.1').pathname}`
    if (route === 'GET /api/conversation') return sendJson(res, 200, { entries: options.conversation.conversation() })
    if (route !== 'POST /api/messages') return sendJson(res, 404, { error: 'not found' })

    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendJson(res, 400, { error: (error as Error).message })
    }
    const { text, id } = (body ?? {}) as { text?: unknown; id?: unknown }
    if (typeof text !== 'string' || !text.trim()) return sendJson(res, 400, { error: 'text is required' })
    if (id !== undefined && (typeof id !== 'string' || !id)) return sendJson(res, 400, { error: 'id must be a non-empty string' })
    const item = userMessage(text.trim(), id ?? randomUUID())
    const received = options.conversation.receive(item)
    if (received) options.wake()
    const posted: PostedMessage = { source: item.source, received }
    return sendJson(res, received ? 202 : 200, posted)
  })
}
