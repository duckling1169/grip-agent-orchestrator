import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { z } from 'zod'

import type { PostedMessage, Snapshot } from '../contracts/api.js'
import { MAX_ATTACHMENTS } from '../contracts/attachments.js'
import { isEngine, LEADER_ENGINES } from '../contracts/engines.js'
import { MoxySettingsBody } from '../contracts/settings.js'
import type { Database } from '../db/database.js'
import { errorText } from '../errors.js'
import { HttpError, listenOnLoopback, readJsonBody, sendJson } from '../http.js'
import type { LoopbackServer } from '../http.js'
import type { LeaderLoop } from '../moxy/loop.js'
import { userMessage } from '../moxy/store.js'
import type { ConversationStore } from '../moxy/store.js'
import type { ModelCatalog } from '../providers/models.js'
import type { Quota } from '../providers/quota.js'
import { QUOTA_ENGINES } from '../providers/quota-readers.js'
import type { Settings } from '../settings.js'
import type { PushNotifier } from '../platform/push.js'
import type { MachineDiscovery } from '../platform/machines.js'
import type { Tasks } from '../tasks/service.js'
import type { Workers } from '../workers/service.js'
import { crossSiteWrite, identify, LOCAL_LOGIN } from './identity.js'
import { serveStatic } from './static.js'
import { UPLOAD_ID, UPLOAD_TYPE, Uploads } from './uploads.js'

export const DEFAULT_WEB_PORT = 18798
const HEARTBEAT_MS = 25_000
const SNAPSHOT_DELAY_MS = 50

export type WebServerOptions = {
  conversation: ConversationStore
  loop: Pick<LeaderLoop, 'wake' | 'stop' | 'sendNow'>
  tasks: Pick<Tasks, 'list' | 'get'>
  workers: Pick<Workers, 'list' | 'detail' | 'changes' | 'activity' | 'message' | 'stop'>
  database: Pick<Database, 'revision' | 'onChange'>
  allowedLogins: readonly string[]
  token: string
  port: number
  host: string
  staticDir: string
  uploadsDir: string
  quota: Quota
  models: Pick<ModelCatalog, 'get'>
  settings: Settings
  push: PushNotifier
  machines: Pick<MachineDiscovery, 'get' | 'refresh'>
  shutdown: () => void
}

const MessageBody = z
  .object({
    text: z.string().trim().default(''),
    id: z.string().min(1).optional(),
    attachments: z
      .array(z.string().regex(UPLOAD_ID, 'Invalid attachment ID'))
      .max(MAX_ATTACHMENTS, `Attach up to ${MAX_ATTACHMENTS} files`)
      .default([]),
  })
  .refine(message => message.text.length > 0 || message.attachments.length > 0, { path: ['text'], message: 'text is required' })
const SettingsBody = z.object({ engine: z.enum(LEADER_ENGINES), model: z.string().min(1).nullable(), effort: z.string().min(1).nullable() })
const RetryBody = z.object({ turnId: z.number().int(), settings: SettingsBody.optional() })
const WorkerMessageBody = z.object({ text: z.string().trim().min(1, 'text is required') })
const PushDeviceBody = z.object({ endpoint: z.string().url().max(4096) })
const PushSubscribeBody = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(4096),
    keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(256) }),
  }),
})

async function body<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse((await readJsonBody(req)) ?? {})
  if (!parsed.success)
    throw new HttpError(400, parsed.error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '))
  return parsed.data
}

export async function startWebServer(options: WebServerOptions): Promise<LoopbackServer> {
  const { conversation, loop, tasks, workers, database, quota, models, settings, push } = options
  const streams = new Map<ServerResponse, string>()
  const uploads = new Uploads(options.uploadsDir)
  let revision = database.revision

  const snapshot = (login: string): Snapshot => {
    const leader = conversation.leader()
    return {
      revision,
      login,
      host: options.host,
      leader: { engine: leader.engine, model: leader.model, effort: leader.effort },
      settings: settings.current(),
      quota: quota.snapshot(),
      conversation: conversation.conversation(),
      tasks: tasks.list(),
      workers: workers.list(),
    }
  }

  let pending: NodeJS.Timeout | null = null
  const publish = () => {
    revision++
    if (pending || streams.size === 0) return
    pending = setTimeout(() => {
      pending = null
      for (const [res, login] of streams) res.write(`event: state\ndata: ${JSON.stringify(snapshot(login))}\n\n`)
    }, SNAPSHOT_DELAY_MS)
  }
  const unsubscribe = database.onChange(publish)
  quota.on('change', publish)
  settings.on('change', publish)

  const openStream = (res: ServerResponse, login: string): void => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    res.write(`retry: 1000\n\nevent: state\ndata: ${JSON.stringify(snapshot(login))}\n\n`)
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS)
    streams.set(res, login)
    res.on('close', () => {
      clearInterval(heartbeat)
      streams.delete(res)
    })
  }

  const postMessage = async (req: IncomingMessage): Promise<PostedMessage> => {
    const { text, id, attachments } = await body(req, MessageBody)
    const files = await Promise.all(
      attachments.map(async id => {
        const file = await uploads.get(id)
        if (!file) throw new HttpError(400, `Attachment ${id} was not found. Upload it again.`)
        return file
      }),
    )
    const item = userMessage(text, id ?? randomUUID(), files)
    const received = conversation.receive(item)
    if (received) loop.wake()
    return { source: item.source, received }
  }

  const route = async (req: IncomingMessage, res: ServerResponse, login: string, path: string): Promise<unknown> => {
    const method = req.method ?? 'GET'
    if (method === 'GET' && path === '/api/events') return openStream(res, login)
    if (method === 'GET' && path === '/api/state') return snapshot(login)
    if (method === 'POST' && path === '/api/shutdown') {
      if (login !== LOCAL_LOGIN) throw new HttpError(403, 'Moxy can be stopped only from its own machine')
      setImmediate(options.shutdown)
      return { pid: process.pid }
    }
    if (method === 'GET' && path === '/api/machines') {
      const refresh = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('refresh') === 'true'
      return refresh ? options.machines.refresh() : options.machines.get()
    }
    if (path === '/api/push' || path.startsWith('/api/push/')) {
      if (!options.allowedLogins.some(allowed => allowed.toLowerCase() === login.toLowerCase()))
        throw new HttpError(403, 'Notifications require an allowed Tailscale login')
      if (method === 'GET' && path === '/api/push') {
        const endpoint = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('endpoint') ?? undefined
        return push.status(login, endpoint)
      }
      if (method === 'POST' && path === '/api/push/subscribe') {
        const { subscription } = await body(req, PushSubscribeBody)
        await push.subscribe(login, subscription)
        return push.status(login, subscription.endpoint)
      }
      if (method === 'POST' && path === '/api/push/unsubscribe') {
        const { endpoint } = await body(req, PushDeviceBody)
        await push.unsubscribe(login, endpoint)
        return push.status(login, endpoint)
      }
      if (method === 'POST' && path === '/api/push/test') return push.test(login)
    }
    if (method === 'POST' && path === '/api/settings') return settings.update(await body(req, MoxySettingsBody))
    const modelRoute = /^\/api\/models\/([\w-]+)$/.exec(path)
    if (method === 'GET' && modelRoute) {
      const engine = modelRoute[1]!
      if (!isEngine(engine)) throw new HttpError(400, `unknown engine ${engine}`)
      return models.get(engine)
    }
    const quotaRoute = /^\/api\/quota\/([\w-]+)\/refresh$/.exec(path)
    if (method === 'POST' && quotaRoute) {
      const engine = QUOTA_ENGINES.find(engine => engine === quotaRoute[1])
      if (!engine) throw new HttpError(400, `quota is not supported for ${quotaRoute[1]}`)
      return quota.refresh([engine])
    }
    if (method === 'POST' && path === '/api/messages') return postMessage(req)
    if (method === 'POST' && path === '/api/uploads') return uploads.save(req)
    const upload = /^\/api\/uploads\/([\da-f-]+)$/.exec(path)?.[1]
    if (method === 'GET' && upload) {
      const attachment = await uploads.get(upload)
      if (!attachment) throw new HttpError(404, 'Attachment not found')
      return uploads.serve(res, attachment)
    }
    if (method === 'POST' && path === '/api/leader/stop') return { stopped: await loop.stop() }
    if (method === 'POST' && path === '/api/leader/send-now') return { stopped: await loop.sendNow() }
    if (method === 'POST' && path === '/api/leader/retry') {
      const retry = await body(req, RetryBody)
      const turn = conversation.retryTurn(retry.turnId, retry.settings)
      loop.wake()
      return turn
    }
    if (method === 'POST' && path === '/api/leader/settings') return conversation.configure(await body(req, SettingsBody))

    const task = /^\/api\/tasks\/([\w-]+)$/.exec(path)
    if (task && method === 'GET') return tasks.get(task[1] as string)
    const worker = /^\/api\/workers\/([\w-]+)(?:\/(changes|activity|message|stop))?$/.exec(path)
    if (worker) {
      const [, id = '', action] = worker
      if (method === 'GET' && !action) return workers.detail(id)
      if (method === 'GET' && action === 'changes') return workers.changes(id)
      if (method === 'GET' && action === 'activity') return workers.activity(id)
      if (method === 'POST' && action === 'message') return workers.message(id, (await body(req, WorkerMessageBody)).text)
      if (method === 'POST' && action === 'stop') return workers.stop(id)
    }
    throw new HttpError(404, `no route ${method} ${path}`)
  }

  const server = await listenOnLoopback(options.port, async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (req.method === 'GET' && path === '/health') return sendJson(res, 200, { ok: true, app: 'moxy' })
    const who = identify(req.headers, options.allowedLogins, options.token)
    if (!who.ok) return sendJson(res, who.status, { error: who.error })
    const isUpload = req.method === 'POST' && path === '/api/uploads'
    const refused = crossSiteWrite(req.method ?? 'GET', req.headers, isUpload ? UPLOAD_TYPE : undefined)
    if (refused) return sendJson(res, 403, { error: refused })
    if (!path.startsWith('/api/')) {
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, options.staticDir)
      return sendJson(res, 404, { error: 'not found' })
    }
    try {
      const result = await route(req, res, who.login, path)
      if (!res.headersSent) sendJson(res, 200, result ?? null)
    } catch (error) {
      if (res.headersSent) return void res.destroy()
      if (isUpload) req.resume()
      sendJson(res, error instanceof HttpError ? error.status : 400, { error: errorText(error) })
    }
  })
  server.server.requestTimeout = 0
  return {
    port: server.port,
    close: async () => {
      unsubscribe()
      quota.off('change', publish)
      settings.off('change', publish)
      if (pending) clearTimeout(pending)
      for (const res of streams.keys()) res.end()
      await server.close()
    },
  }
}
