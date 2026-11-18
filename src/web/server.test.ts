import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ChatManager } from '../chats/manager.js'
import { ChatStore } from '../chats/store.js'
import type { ClawHistoryEntry } from '../claw/state.js'
import { Worktrees } from '../git/worktrees.js'
import { Quota } from '../quota/quota.js'
import type { QuotaReaders } from '../quota/readers.js'
import { RunManager } from '../runs/manager.js'
import { RunStore } from '../runs/store.js'
import { FakeClaw } from '../testing/fake-claw.js'
import { tailnetOrigin } from './identity.js'
import { startWebHttp } from './server.js'

const LOGIN = 'duckling1169@github'
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=grip-test', '-c', 'user.email=grip@test', '-C', cwd, ...args], { encoding: 'utf8' }).trim()

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

class FakeClawStatus extends EventEmitter<{ status: [string] }> {
  status = 'ready'
  version: string | null = '7.23.4'
  history?: ClawHistoryEntry[]
  set(status: string) {
    this.status = status
    this.emit('status', status)
  }
}

async function setup(withStatic = false) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'grip-web-')))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  const repo = join(base, 'app')
  await mkdir(repo)
  git(base, 'init', '-q', '-b', 'main', repo)
  await writeFile(join(repo, 'README.md'), 'app\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'init')
  const plain = join(base, 'notes')
  await mkdir(plain)
  const staticDir = join(base, 'web-dist')
  if (withStatic) {
    await mkdir(staticDir)
    await writeFile(join(staticDir, 'index.html'), '<h1>Grip</h1>')
  }

  const store = await RunStore.open(join(base, 'home'))
  const claw = new FakeClaw()
  const worktrees = new Worktrees()
  const manager = new RunManager({ store, worktrees, claw })
  const chatStore = await ChatStore.open(join(base, 'home'))
  const chats = new ChatManager({
    chats: chatStore,
    runs: manager,
    runStore: store,
    claw,
    secret: 'test-secret',
    mcpUrl: () => 'http://127.0.0.1:18797/mcp',
  })
  const window = { name: '5h', usedPercent: 90, resetsAt: '2099-01-01T00:00:00.000Z', stale: false, observedAt: null }
  const readers: QuotaReaders = {
    codex: async () => ({ provider: 'codex', windows: [window] }),
    agy: async () => null,
    claude: async () => {
      throw new Error('tests never call real models')
    },
  }
  const quota = await Quota.open({ path: join(base, 'home', 'quota.json'), readers })
  const clawStatus = new FakeClawStatus()
  const web = await startWebHttp({
    manager,
    store,
    chats,
    chatStore,
    quota,
    worktrees,
    claw: clawStatus,
    allowedLogins: [LOGIN],
    keepAwake: () => ({ supported: true, holding: store.running().length > 0 }),
    port: 0,
    host: 'windows-pc',
    staticDir,
    models: { list: async () => [{ engine: 'codex', models: [], error: null }] },
    trustedOrigin: origin => tailnetOrigin(origin, '.tail.ts.net'),
  })
  cleanups.push(() => web.close())
  cleanups.push(() => chats.stopAll())
  const url = `http://127.0.0.1:${web.port}`

  /** A request as tailscale serve would pass it on from an allowed device. */
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { 'Tailscale-User-Login': LOGIN, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: res.status, body: (await res.json()) as any }
  }
  return { base, repo, plain, store, chats, chatStore, claw, manager, quota, clawStatus, url, api }
}

describe('web API identity', () => {
  it('includes update history in state when supplied by the supervisor', async () => {
    const t = await setup()
    t.clawStatus.history = [{ at: '2026-11-18T00:00:00.000Z', kind: 'updated', from: '7.23.4', to: '7.24.0' }]
    expect((await t.api('GET', '/api/state')).body.claw.history).toEqual(t.clawStatus.history)
  })

  it('requires identity for the built app and leaves health public', async () => {
    const t = await setup(true)
    expect((await fetch(`${t.url}/`)).status).toBe(401)
    expect((await fetch(`${t.url}/`, { headers: { 'Tailscale-User-Login': 'someone@github' } })).status).toBe(403)
    const page = await fetch(`${t.url}/`, { headers: { 'Tailscale-User-Login': LOGIN } })
    expect(page.status).toBe(200)
    expect(await page.text()).toBe('<h1>Grip</h1>')
    expect((await fetch(`${t.url}/health`)).status).toBe(200)
    expect((await t.api('GET', '/api/missing')).status).toBe(404)
  })

  it('reports a missing build without affecting the API', async () => {
    const t = await setup()
    const page = await fetch(`${t.url}/`, { headers: { 'Tailscale-User-Login': LOGIN } })
    expect(page.status).toBe(503)
    expect(await page.text()).toContain('Web app not built')
    expect((await t.api('GET', '/api/state')).status).toBe(200)
  })
  it('answers /health to anyone, and nothing else without an allowed login', async () => {
    const t = await setup()
    expect((await fetch(`${t.url}/health`)).status).toBe(200)
    expect((await fetch(`${t.url}/api/state`)).status).toBe(401)
    const stranger = await fetch(`${t.url}/api/state`, { headers: { 'Tailscale-User-Login': 'someone@github' } })
    expect(stranger.status).toBe(403)
    expect((await t.api('GET', '/api/state')).status).toBe(200)
  })

  it('refuses cross-site writes', async () => {
    const t = await setup()
    const form = await t.api('POST', '/api/stop-all', undefined, { 'Content-Type': 'application/x-www-form-urlencoded' })
    expect(form.status).toBe(403)
    const foreign = await t.api('POST', '/api/stop-all', {}, { Origin: 'https://evil.example' })
    expect(foreign.status).toBe(403)
  })
})

describe('web API from another Grip machine', () => {
  const other = 'https://linux-box.tail.ts.net'

  it('answers the preflight only for tailnet Grip origins', async () => {
    const t = await setup()
    const ok = await fetch(`${t.url}/api/stop-all`, { method: 'OPTIONS', headers: { Origin: other } })
    expect(ok.status).toBe(204)
    expect(ok.headers.get('access-control-allow-origin')).toBe(other)
    expect(ok.headers.get('access-control-allow-methods')).toBe('GET, POST, DELETE')
    expect(ok.headers.get('access-control-allow-headers')).toBe('Content-Type')
    const evil = await fetch(`${t.url}/api/stop-all`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })
    expect(evil.status).toBe(403)
    expect(evil.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('lets that origin read and write, still behind identity', async () => {
    const t = await setup()
    const read = await fetch(`${t.url}/api/state`, { headers: { Origin: other, 'Tailscale-User-Login': LOGIN } })
    expect(read.status).toBe(200)
    expect(read.headers.get('access-control-allow-origin')).toBe(other)
    expect(read.headers.get('vary')).toBe('Origin')
    const anonymous = await fetch(`${t.url}/api/state`, { headers: { Origin: other } })
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('access-control-allow-origin')).toBe(other)
    expect((await t.api('POST', '/api/stop-all', {}, { Origin: other })).status).toBe(200)
    const foreign = await fetch(`${t.url}/api/state`, { headers: { Origin: 'https://evil.example', 'Tailscale-User-Login': LOGIN } })
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('sends the CORS header on the event stream and on health', async () => {
    const t = await setup()
    const health = await fetch(`${t.url}/health`, { headers: { Origin: other } })
    expect(health.headers.get('access-control-allow-origin')).toBe(other)
    const controller = new AbortController()
    const events = await fetch(`${t.url}/api/events`, {
      headers: { Origin: other, 'Tailscale-User-Login': LOGIN },
      signal: controller.signal,
    })
    expect(events.headers.get('access-control-allow-origin')).toBe(other)
    controller.abort()
  })
})

describe('web API runs', () => {
  it('delegates, shows the run, and marks it seen by the app when opened', async () => {
    const t = await setup()
    const made = await t.api('POST', '/api/runs', { folder: t.plain, engine: 'agy', brief: { text: 'Say hi' } })
    expect(made.status).toBe(200)
    expect(made.body).toMatchObject({ title: 'Say hi', engine: 'agy', status: 'running' })

    const state = await t.api('GET', '/api/state')
    expect(state.body).toMatchObject({
      you: LOGIN,
      principal: { host: 'windows-pc', online: true },
      claw: { status: 'ready', version: '7.23.4' },
      keepAwake: { supported: true, holding: true },
      runs: [{ id: made.body.id, status: 'running' }],
    })

    await t.claw.waitForSend(`grip-${made.body.id}`)
    t.claw.answer(`grip-${made.body.id}`, { output: 'hi' })
    await t.manager.settled(made.body.id)
    expect(t.store.get(made.body.id)?.viewed).toBe(false)
    const detail = await t.api('GET', `/api/runs/${made.body.id}`)
    expect(detail.body).toMatchObject({
      status: 'done',
      unread: true,
      unseen: false,
      turns: [{ turn: 1, message: 'Say hi', output: 'hi' }],
    })
    expect(t.store.get(made.body.id)).toMatchObject({ viewed: false, seen: true })
  })

  it('messages, stops and retries a run on another engine', async () => {
    const t = await setup()
    const run = (await t.api('POST', '/api/runs', { folder: t.plain, engine: 'codex', brief: { text: 'Do it' } })).body
    // Busy runs cannot take a message yet.
    expect((await t.api('POST', `/api/runs/${run.id}/message`, { text: 'more' })).status).toBe(400)
    await t.claw.waitForSend(`grip-${run.id}`)
    expect((await t.api('POST', `/api/runs/${run.id}/stop`, {})).body.status).toBe('stopped')
    await t.manager.settled(run.id)

    const changed = await t.api('POST', `/api/runs/${run.id}/settings`, { model: 'gpt-6.1', effort: 'high' })
    expect(changed.body).toMatchObject({ model: 'gpt-6.1', effort: 'high' })
    expect((await t.api('POST', `/api/runs/${run.id}/settings`, { model: '' })).status).toBe(400)
    const followUp = await t.api('POST', `/api/runs/${run.id}/message`, { text: 'more' })
    expect(followUp.body).toMatchObject({ status: 'running' })
    expect(t.claw.starts.at(-1)).toMatchObject({ model: 'gpt-6.1', effort: 'high' })
    expect(t.store.get(run.id)?.fromUser).toContain(2)
    expect((await t.store.turn(run.id, 1)).message).toBe('Do it')
    await t.claw.waitForSend(`grip-${run.id}`)
    t.claw.answer(`grip-${run.id}`, { output: 'done' })
    await t.manager.settled(run.id)

    const retry = await t.api('POST', `/api/runs/${run.id}/retry`, { engine: 'claude' })
    expect(retry.body).toMatchObject({ engine: 'claude', retryOf: run.id, title: 'Do it', status: 'running' })
    expect((await t.api('POST', '/api/runs/r-nope/stop', {})).status).toBe(404)
  })

  it('stops everything at once', async () => {
    const t = await setup()
    await t.api('POST', '/api/runs', { folder: t.plain, engine: 'codex', brief: { text: 'A' } })
    await t.api('POST', '/api/runs', { folder: t.plain, engine: 'agy', brief: { text: 'B' } })
    const all = await t.api('POST', '/api/stop-all', {})
    expect(all.body.stopped.map((r: { status: string }) => r.status)).toEqual(['stopped', 'stopped'])
    expect(all.body.killedWorkers).toBe(false)
  })

  it('rejects bad input with the reason', async () => {
    const t = await setup()
    const bad = await t.api('POST', '/api/runs', { folder: t.plain, engine: 'gpt', brief: {} })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toContain('engine')
    expect((await t.api('GET', '/api/nothing')).status).toBe(404)
  })
})

describe('web API chats', () => {
  it('lists models and browses folders', async () => {
    const t = await setup()
    expect((await t.api('GET', '/api/models')).body).toEqual([{ engine: 'codex', models: [], error: null }])
    const roots = await t.api('GET', '/api/folders')
    expect(roots.body.path).toBeNull()
    expect(roots.body.folders[0].name).toBe('Home')
    const listing = await t.api('GET', `/api/folders?path=${encodeURIComponent(t.base)}`)
    expect(listing.body.folders).toEqual(
      expect.arrayContaining([
        { name: 'app', path: join(t.base, 'app'), repo: true },
        { name: 'notes', path: join(t.base, 'notes'), repo: false },
      ]),
    )
    expect((await t.api('GET', `/api/folders?path=${encodeURIComponent(join(t.base, 'missing'))}`)).status).toBe(404)
    expect((await fetch(`${t.url}/api/folders`)).status).toBe(401)
  })

  it('starts, lists, reads, messages and stops a chat', async () => {
    const t = await setup()
    const made = await t.api('POST', '/api/chats', { folder: t.plain, engine: 'claude', message: 'Hello' })
    expect(made.status).toBe(200)
    expect(made.body).toMatchObject({ kind: 'grip', title: 'Hello', status: 'working' })
    const id = made.body.id
    expect((await t.api('GET', '/api/state')).body.chats).toEqual([expect.objectContaining({ id, runs: [] })])
    const detail = await t.api('GET', `/api/chats/${id}`)
    expect(detail.body).toMatchObject({ chat: { id }, runs: [], timeline: [{ kind: 'message', text: 'Hello' }] })
    expect((await t.api('POST', `/api/chats/${id}/message`, { text: 'Follow up' })).status).toBe(200)
    expect((await t.api('POST', `/api/chats/${id}/stop`, {})).body.status).toBe('stopped')
    const changed = await t.api('POST', `/api/chats/${id}/settings`, { model: 'claude-sonnet-5-5', effort: null })
    expect(changed.body).toMatchObject({ model: 'claude-sonnet-5-5', effort: null })
    expect((await t.api('POST', '/api/chats/c-nope/settings', { model: null, effort: null })).status).toBe(404)
    expect((await t.api('GET', '/api/chats/c-nope')).status).toBe(404)
    expect((await t.api('POST', '/api/chats/c-nope/message', { text: 'x' })).status).toBe(404)
    expect((await t.api('POST', '/api/chats', { folder: t.plain, engine: 'invalid', message: 'x' })).status).toBe(400)
  })

  it('deletes a chat and hides its workers', async () => {
    const t = await setup()
    const chat = (await t.api('POST', '/api/chats', { folder: t.plain, engine: 'claude' })).body
    const run = await t.manager.delegate({ folder: t.plain, engine: 'codex', brief: { text: 'Fix it' }, chatId: chat.id })
    await t.claw.waitForSend(run.session)
    expect((await t.api('DELETE', `/api/chats/${chat.id}`, {})).body).toEqual({ deleted: chat.id })
    expect(t.store.get(run.id)?.status).toBe('stopped')
    const state = (await t.api('GET', '/api/state')).body
    expect(state.chats).toEqual([])
    expect(state.runs).toEqual([])
    expect((await t.api('GET', `/api/chats/${chat.id}`)).status).toBe(404)
    expect((await t.api('DELETE', `/api/chats/${chat.id}`, {})).status).toBe(404)
  })

  it('stops working chats with stop-all', async () => {
    const t = await setup()
    const chat = (await t.api('POST', '/api/chats', { folder: t.plain, engine: 'claude', message: 'Hi' })).body
    const all = await t.api('POST', '/api/stop-all', {})
    expect(all.body.stoppedChats).toEqual([expect.objectContaining({ id: chat.id, status: 'stopped' })])
  })

  it('keeps a retried worker attached to its chat', async () => {
    const t = await setup()
    const chat = await t.chats.externalChat({ folder: t.plain, title: 'Fix the app' })
    const run = await t.manager.delegate({ folder: t.plain, engine: 'codex', brief: { text: 'Fix' }, chatId: chat.id })
    await t.claw.waitForSend(run.session)
    await t.manager.stop(run.id)
    await t.manager.settled(run.id)
    const retry = await t.api('POST', `/api/runs/${run.id}/retry`, { engine: 'agy' })
    expect(retry.body).toMatchObject({ chatId: chat.id, retryOf: run.id, engine: 'agy' })
    expect((await t.api('GET', `/api/chats/${chat.id}`)).body.runs).toHaveLength(2)
  })
})

describe('web API quota and worktrees', () => {
  it('refreshes quota on request and notes a low provider on delegate', async () => {
    const t = await setup()
    const snap = await t.api('POST', '/api/quota/refresh', {})
    expect(snap.body.verdict.text).toBe('Codex is running low (10% left)')
    const run = await t.api('POST', '/api/runs', { folder: t.plain, engine: 'codex', brief: { text: 'x' } })
    expect(run.body.quotaNote).toBe('Codex is running low (10% left)')
  })

  it('lists run worktrees with their size, and removes only finished ones', async () => {
    const t = await setup()
    const run = (await t.api('POST', '/api/runs', { folder: t.repo, engine: 'codex', brief: { text: 'Edit readme' } })).body
    const listed = await t.api('GET', '/api/worktrees')
    expect(listed.body).toHaveLength(1)
    expect(listed.body[0]).toMatchObject({ path: run.worktree, branch: run.branch, run: { id: run.id } })
    expect(listed.body[0].bytes).toBeGreaterThan(0)

    expect((await t.api('DELETE', '/api/worktrees', { path: run.worktree })).status).toBe(409)
    await t.claw.waitForSend(`grip-${run.id}`)
    t.claw.answer(`grip-${run.id}`, { output: 'ok' })
    await t.manager.settled(run.id)
    const removed = await t.api('DELETE', '/api/worktrees', { path: run.worktree })
    expect(removed.body).toEqual({ branchDeleted: true, branch: run.branch })
    await expect(stat(run.worktree)).rejects.toThrow()
    expect((await t.api('DELETE', '/api/worktrees', { path: t.repo })).status).toBe(404)
  })
})

describe('web API events', () => {
  it('streams the state first, then chat, run, quota and Claw changes', async () => {
    const t = await setup()
    const events: { event: string; data: any }[] = []
    let text = ''
    const req = request(`${t.url}/api/events`, { headers: { 'Tailscale-User-Login': LOGIN } }, res => {
      res.setEncoding('utf8').on('data', (chunk: string) => {
        text += chunk
        let end: number
        while ((end = text.indexOf('\n\n')) >= 0) {
          const block = text.slice(0, end)
          text = text.slice(end + 2)
          const event = /^event: (.+)$/m.exec(block)?.[1]
          const data = /^data: (.+)$/m.exec(block)?.[1]
          if (event && data) events.push({ event, data: JSON.parse(data) })
        }
      })
    })
    req.end()
    cleanups.push(async () => req.destroy())
    const until = async (n: number) => {
      for (let i = 0; i < 200 && events.length < n; i++) await new Promise(r => setTimeout(r, 10))
    }

    await until(1)
    expect(events[0]).toMatchObject({ event: 'state', data: { you: LOGIN, runs: [] } })
    await t.api('POST', '/api/runs', { folder: t.plain, engine: 'agy', brief: { text: 'Hi' } })
    await t.api('POST', '/api/chats', { folder: t.plain, engine: 'claude', message: 'Hello' })
    t.clawStatus.set('updating')
    await t.quota.refresh(['codex'])
    await until(5)
    const kinds = events.map(e => e.event)
    expect(kinds).toContain('run')
    expect(kinds).toContain('chat')
    expect(kinds).toContain('quota')
    expect(events.find(e => e.event === 'claw')?.data).toEqual({ status: 'updating', version: '7.23.4' })
    expect(events.find(e => e.event === 'run')?.data).toMatchObject({ title: 'Hi', status: 'running' })
  })
})
