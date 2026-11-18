import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hostname } from 'node:os'

import { z } from 'zod'

import type { ChatManager } from '../chats/manager.js'
import type { Chat, ChatStore } from '../chats/store.js'
import type { ClawHistoryEntry } from '../claw/state.js'
import { diskUsage, samePath } from '../git/worktrees.js'
import type { Worktrees } from '../git/worktrees.js'
import { readJsonBody, sendJson } from '../http-util.js'
import { ModelCatalog } from '../models.js'
import type { Quota, QuotaSnapshot } from '../quota/quota.js'
import { TOOLS } from '../quota/usage.js'
import type { ToolId } from '../quota/usage.js'
import type { RunManager } from '../runs/manager.js'
import { present, summarize } from '../runs/present.js'
import { ENGINES } from '../runs/store.js'
import type { Engine, Run, RunStore } from '../runs/store.js'
import { listFolders } from './folders.js'
import { listMachines, tailnetSuffix } from './machines.js'
import type { MachineList } from './machines.js'
import { crossSiteWrite, identify, tailnetOrigin } from './identity.js'
import { serveStatic } from './static.js'

export const DEFAULT_WEB_PORT = 18798
const HEARTBEAT_MS = 25_000

/** Claw's state as the app shows it. The supervisor fits this. */
export interface ClawStatusSource {
  readonly status: string
  readonly version: string | null
  readonly history?: readonly ClawHistoryEntry[]
  on(event: 'status', listener: (status: never) => void): unknown
  off(event: 'status', listener: (status: never) => void): unknown
}

export type WebOptions = {
  manager: RunManager
  store: RunStore
  chats: ChatManager
  chatStore: ChatStore
  quota: Quota
  worktrees: Worktrees
  claw: ClawStatusSource
  /** Logins allowed in, from config.json. */
  allowedLogins: readonly string[]
  /** Whether the machine is being kept awake now, and whether it can be on this platform. */
  keepAwake?: () => { supported: boolean; holding: boolean }
  port?: number
  host?: string
  /** Built web app directory; defaults to web/dist in the project. */
  staticDir?: string
  /** Each agent's models for the app's pickers. */
  models?: Pick<ModelCatalog, 'list'>
  /** Tailnet machines for the app's machine switcher. */
  machines?: () => Promise<MachineList>
  /**
   * Which other origins' apps may call this Grip. Defaults to the other Grip machines on this
   * tailnet (`https://<name>.<tailnet>.ts.net`), read from Tailscale once at start.
   */
  trustedOrigin?: (origin: string) => boolean
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const engine = z.enum(ENGINES as [Engine, ...Engine[]])
const provider = z.enum(TOOLS as [ToolId, ...ToolId[]])
const DelegateBody = z.object({
  folder: z.string().min(1),
  engine,
  brief: z.object({ path: z.string().optional(), text: z.string().optional() }),
  model: z.string().optional(),
  effort: z.string().optional(),
  retryOf: z.string().optional(),
})
const MessageBody = z.object({ text: z.string() })
const RenameBody = z.object({ title: z.string().trim().min(1).max(200) })
const SettingsBody = z.object({ model: z.string().min(1).nullable(), effort: z.string().min(1).nullable() })
const ChatBody = z.object({
  folder: z.string().min(1),
  engine,
  model: z.string().optional(),
  effort: z.string().optional(),
  message: z.string().optional(),
})
const RetryBody = z.object({ engine: engine.optional(), model: z.string().optional(), effort: z.string().optional() })
const RefreshBody = z.object({ providers: z.array(provider).optional() })
const RemoveWorktreeBody = z.object({ path: z.string().min(1) })

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {})
  if (!result.success) throw new HttpError(400, result.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '))
  return result.data
}

/**
 * The web API for devices (design §12): loopback only, reached through `tailscale serve`, and
 * answering only allowlisted Tailscale logins. `GET /api/events` streams run, quota and Claw
 * changes, so the app never polls.
 */
export async function startWebHttp(options: WebOptions): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const { manager, store, chats, chatStore, quota, worktrees, claw } = options
  const models = options.models ?? new ModelCatalog()
  const host = options.host ?? hostname()
  const streams = new Set<ServerResponse>()
  const suffix = options.trustedOrigin ? null : await tailnetSuffix()
  const trusted = options.trustedOrigin ?? ((origin: string) => tailnetOrigin(origin, suffix))

  const clawState = () => ({
    status: claw.status,
    version: claw.version,
    ...(claw.history ? { history: structuredClone(claw.history) } : {}),
  })
  const state = (login: string) => ({
    you: login,
    principal: { host, online: true },
    claw: clawState(),
    keepAwake: options.keepAwake?.() ?? { supported: false, holding: false },
    quota: quota.snapshot(),
    chats: chats.list().map(chat => ({ ...chat, runs: manager.list({ chatId: chat.id }).map(summarize) })),
    // A deleted chat's workers leave with it.
    runs: manager
      .list()
      .filter(run => !run.chatId || !chatStore.isDeleted(run.chatId))
      .map(summarize),
  })

  async function delegate(input: z.infer<typeof DelegateBody> & { chatId?: string }) {
    const run = await manager.delegate({
      folder: input.folder,
      engine: input.engine,
      brief: input.brief,
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.retryOf ? { retryOf: input.retryOf } : {}),
      ...(input.chatId ? { chatId: input.chatId } : {}),
    })
    const quotaNote = quota.noteFor(run.engine)
    return { ...summarize(run), ...(quotaNote ? { quotaNote } : {}) }
  }

  function mustRun(id: string): Run {
    const run = store.get(id)
    if (!run) throw new HttpError(404, `unknown run ${id}`)
    return run
  }

  async function listWorktrees() {
    const byRoot = new Map<string, Run[]>()
    // Deleted runs leave their worktrees behind, so they still count here.
    for (const run of store.list({ deleted: true })) if (run.repo) byRoot.set(run.repo.root, [...(byRoot.get(run.repo.root) ?? []), run])
    const out = []
    for (const [root, runs] of byRoot) {
      const listed = await worktrees.list(root).catch(() => [])
      for (const w of listed) {
        const run = runs.find(r => samePath(r.repo!.worktree, w.path)) ?? null
        const disk = await diskUsage(w.path)
        // git lists paths with forward slashes on Windows; the run's own path matches the rest of the app.
        out.push({
          ...w,
          path: run?.repo?.worktree ?? w.path,
          repo: root,
          bytes: disk.bytes,
          sizeComplete: disk.complete,
          // A deleted worker still names its worktree, so you can tell what you are removing.
          run: run && summarize(run),
        })
      }
    }
    return out
  }

  async function removeWorktree(path: string) {
    const run = store.list({ deleted: true }).find(r => r.repo && samePath(r.repo.worktree, path))
    if (!run?.repo) throw new HttpError(404, `${path} is not the worktree of a Grip run`)
    if (run.status === 'running') throw new HttpError(409, `run ${run.id} is still working in ${path}; stop it first`)
    return worktrees.remove(run.repo.root, run.repo.worktree, run.repo.base)
  }

  async function route(req: IncomingMessage, res: ServerResponse, login: string, path: string): Promise<unknown> {
    const method = req.method ?? 'GET'
    const runMatch = /^\/api\/runs\/([\w-]+)(?:\/(message|stop|retry|settings|rename))?$/.exec(path)
    const chatMatch = /^\/api\/chats\/([\w-]+)(?:\/(message|stop|settings|rename))?$/.exec(path)

    if (method === 'GET' && path === '/api/state') return state(login)
    if (method === 'GET' && path === '/api/models') return models.list()
    if (method === 'GET' && path === '/api/machines') return (options.machines ?? listMachines)()
    if (method === 'GET' && path === '/api/folders') {
      const at = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('path')
      return listFolders(at).catch(error => {
        throw new HttpError(404, (error as Error).message)
      })
    }
    if (method === 'GET' && path === '/api/events') return openStream(res, login)
    if (method === 'POST' && path === '/api/runs') return delegate(parse(DelegateBody, await readJsonBody(req)))
    if (method === 'POST' && path === '/api/chats') return chats.startChat(parse(ChatBody, await readJsonBody(req)))
    if (method === 'POST' && path === '/api/stop-all') {
      // Stop chat supervision first so a finishing worker cannot wake its parent during Stop all.
      const [chatResult, { stopped, killed }] = await Promise.all([chats.stopAll(), manager.stopAll()])
      return { stopped: stopped.map(summarize), killedWorkers: killed || chatResult.killed, stoppedChats: chatResult.stopped }
    }
    if (method === 'POST' && path === '/api/quota/refresh') {
      const body = parse(RefreshBody, await readJsonBody(req))
      return quota.refresh(body.providers ?? undefined)
    }
    if (method === 'GET' && path === '/api/worktrees') return listWorktrees()
    if (method === 'DELETE' && path === '/api/worktrees') return removeWorktree(parse(RemoveWorktreeBody, await readJsonBody(req)).path)

    if (chatMatch) {
      const [, id, action] = chatMatch as unknown as [string, string, string | undefined]
      const chat = chats.get(id)
      if (!chat) throw new HttpError(404, `unknown chat ${id}`)
      if (method === 'GET' && !action)
        return { chat, runs: manager.list({ chatId: id }).map(summarize), timeline: await chats.timeline(id) }
      if (method === 'POST' && action === 'message') return chats.message(id, parse(MessageBody, await readJsonBody(req)).text)
      if (method === 'POST' && action === 'stop') return chats.stop(id)
      if (method === 'POST' && action === 'settings') {
        if (chat.kind !== 'grip') throw new HttpError(400, 'This chat runs in its own host; change its model there.')
        // The next turn uses them; a turn already running keeps its own.
        return chatStore.configure(id, parse(SettingsBody, await readJsonBody(req)))
      }
      if (method === 'POST' && action === 'rename') return chats.rename(id, parse(RenameBody, await readJsonBody(req)).title)
      if (method === 'DELETE' && !action) return chats.delete(id)
    }
    if (runMatch) {
      const [, id, action] = runMatch as unknown as [string, string, string | undefined]
      if (method === 'GET' && !action) {
        mustRun(id)
        // Opening a run in the app marks it seen, independently of its orchestrator.
        return present(await manager.details(id, { diff: true, markViewed: 'app' }))
      }
      if (method === 'POST' && action === 'message') {
        mustRun(id)
        return summarize(await manager.message(id, parse(MessageBody, await readJsonBody(req)).text, { fromUser: true }))
      }
      if (method === 'POST' && action === 'settings') {
        mustRun(id)
        return summarize(await store.configure(id, parse(SettingsBody, await readJsonBody(req))))
      }
      if (method === 'POST' && action === 'stop') {
        mustRun(id)
        return summarize(await manager.stop(id))
      }
      if (method === 'POST' && action === 'rename') {
        mustRun(id)
        return summarize(await manager.rename(id, parse(RenameBody, await readJsonBody(req)).title))
      }
      if (method === 'DELETE' && !action) {
        mustRun(id)
        return manager.delete(id)
      }
      if (method === 'POST' && action === 'retry') {
        const run = mustRun(id)
        const body = parse(RetryBody, await readJsonBody(req))
        return delegate({
          folder: run.folder,
          engine: body.engine ?? run.engine,
          brief: run.brief.kind === 'path' ? { path: run.brief.path } : { text: run.brief.text },
          ...(body.model ? { model: body.model } : {}),
          ...(body.effort ? { effort: body.effort } : {}),
          retryOf: run.id,
          ...(run.chatId ? { chatId: run.chatId } : {}),
        })
      }
    }
    throw new HttpError(404, 'not found')
  }

  /** Server-sent events: the whole state once, then each change as it happens. */
  function openStream(res: ServerResponse, login: string): typeof STREAMING {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    const write = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    // Ask the browser to come back within a second after a dropped stream.
    res.write('retry: 1000\n\n')
    write('state', state(login))
    const onRun = (run: Run) => {
      if (store.isDeleted(run.id)) write('run-deleted', { id: run.id })
      else if (!run.chatId || !chatStore.isDeleted(run.chatId)) write('run', summarize(run))
    }
    const onChat = (chat: Chat) => (chatStore.isDeleted(chat.id) ? write('chat-deleted', { id: chat.id }) : write('chat', chat))
    const onQuota = (snapshot: QuotaSnapshot) => write('quota', snapshot)
    const onClaw = () => write('claw', clawState())
    store.on('change', onRun)
    chatStore.on('change', onChat)
    quota.on('change', onQuota)
    claw.on('status', onClaw)
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS)
    streams.add(res)
    res.on('close', () => {
      clearInterval(heartbeat)
      store.off('change', onRun)
      chatStore.off('change', onChat)
      quota.off('change', onQuota)
      claw.off('status', onClaw)
      streams.delete(res)
    })
    return STREAMING
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(error => {
      if (res.headersSent) return void res.destroy()
      const status = error instanceof HttpError ? error.status : 400
      sendJson(res, status, { error: (error as Error).message })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const api = path === '/health' || path === '/api' || path.startsWith('/api/')
    // Another machine's Grip app may call this one (DESIGN §12); any other site gets no CORS headers.
    const origin = req.headers.origin
    const cors = api && typeof origin === 'string' && trusted(origin)
    if (cors) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    if (req.method === 'OPTIONS') {
      // A preflight carries no identity, so it says nothing beyond whether the origin may ask.
      if (!cors) return sendJson(res, 403, { error: 'Origin may not call Grip' })
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      })
      return void res.end()
    }
    if (req.method === 'GET' && path === '/health') return sendJson(res, 200, { ok: true, app: 'grip' })
    const who = identify(req.headers, options.allowedLogins)
    if (!who.ok) return sendJson(res, who.status, { error: who.error })
    const refused = crossSiteWrite(req.method ?? 'GET', req.headers, cors ? trusted : undefined)
    if (refused) return sendJson(res, 403, { error: refused })
    if ((req.method === 'GET' || req.method === 'HEAD') && path !== '/api' && !path.startsWith('/api/'))
      return serveStatic(req, res, options.staticDir)
    const result = await route(req, res, who.login, path)
    if (result !== STREAMING) sendJson(res, 200, result ?? null)
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? DEFAULT_WEB_PORT, '127.0.0.1', () => resolve())
  })
  // Event streams stay open as long as the app does.
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  return {
    server,
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise(resolve => {
        for (const res of streams) res.end()
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

const STREAMING = Symbol('streaming')
