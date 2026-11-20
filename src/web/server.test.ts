import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Moxy } from '../app.js'
import type { Snapshot } from '../contracts/api.js'
import type { LeaderReply, LeaderRunner } from '../runtime/leaders/leader.js'
import { temporaryHome } from '../testing/harness.js'
import { ALLOWED_LOGIN, echoLeader, startTestMoxy } from '../testing/test-moxy.js'
import { inboxPart } from '../moxy/prompt.js'
import type { PushMessage, PushStatus } from '../contracts/push.js'
import type { PushSender } from '../platform/push.js'

const pushSubscription = (id: string) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
  keys: {
    p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'),
    auth: Buffer.alloc(16, 2).toString('base64url'),
  },
})

type Call = { method?: string; body?: unknown; headers?: Record<string, string> }

function call(moxy: Moxy, path: string, { method = 'GET', body, headers = {} }: Call = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${moxy.webPort}${path}`, {
    method,
    headers: {
      'Tailscale-User-Login': ALLOWED_LOGIN,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function json<T>(response: Promise<Response>): Promise<T> {
  return (await (await response).json()) as T
}

function upload(moxy: Moxy, name: string, type: string, body: string | Uint8Array<ArrayBuffer>, headers = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${moxy.webPort}/api/uploads`, {
    method: 'POST',
    body,
    headers: {
      'Tailscale-User-Login': ALLOWED_LOGIN,
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(name),
      'X-File-Type': type,
      ...headers,
    },
  })
}

async function* snapshots(moxy: Moxy): AsyncGenerator<Snapshot> {
  const response = await call(moxy, '/api/events')
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buffered = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffered += value
      let end: number
      while ((end = buffered.indexOf('\n\n')) >= 0) {
        const event = buffered.slice(0, end)
        buffered = buffered.slice(end + 2)
        const data = /^event: state\ndata: (.*)$/m.exec(event)?.[1]
        if (data) yield JSON.parse(data) as Snapshot
      }
    }
  } finally {
    await reader.cancel()
  }
}

async function until(stream: AsyncGenerator<Snapshot>, done: (snapshot: Snapshot) => boolean): Promise<Snapshot> {
  for (;;) {
    const next = await stream.next()
    if (next.done) throw new Error('the event stream ended')
    if (done(next.value)) return next.value
  }
}

const answered = (text: string) => (snapshot: Snapshot) =>
  snapshot.conversation.some(entry => entry.type === 'moxy' && entry.turn.status === 'finished' && entry.turn.output === text)

describe('web server', () => {
  it('stores attachments safely, serves them to authorized users, and delivers their paths to the leader', async () => {
    const leader = echoLeader()
    const moxy = await startTestMoxy({ leaders: () => leader })
    expect((await upload(moxy, 'test.png', 'image/png', 'data', { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await upload(moxy, 'test.png', 'image/png', 'data', { 'Tailscale-User-Login': '' })).status).toBe(401)
    const token = (await readFile(moxy.paths.webToken, 'utf8')).trim()
    expect(
      (await upload(moxy, 'test.png', 'image/png', 'data', { 'Tailscale-User-Login': 'outsider', Authorization: `Bearer ${token}` }))
        .status,
    ).toBe(403)
    const image = await json<{ id: string }>(upload(moxy, '../../test.png', 'image/png', 'data'))
    const file = await json<{ id: string }>(
      upload(moxy, 'notes.html', 'text/html', 'hello', { 'Tailscale-User-Login': '', Authorization: `Bearer ${token}` }),
    )
    const imagePath = join(moxy.paths.home, 'uploads', image.id, 'test.png')
    const filePath = join(moxy.paths.home, 'uploads', file.id, 'notes.html')
    expect(await readFile(imagePath, 'utf8')).toBe('data')
    const imageUrl = `/api/uploads/${image.id}`
    expect((await call(moxy, imageUrl, { headers: { 'Tailscale-User-Login': '' } })).status).toBe(401)
    expect((await call(moxy, `${imageUrl}/%2e%2e%2f%2e%2e%2fweb-token`)).status).toBe(404)
    await symlink(join(moxy.paths.uploads, image.id), join(moxy.paths.uploads, '01234567-89ab-cdef-0123-456789abcdef'), 'junction')
    expect((await call(moxy, '/api/uploads/01234567-89ab-cdef-0123-456789abcdef')).status).toBe(404)
    const inline = await call(moxy, imageUrl)
    expect(inline.headers.get('content-type')).toBe('image/png')
    expect(inline.headers.get('content-disposition')).toMatch(/^inline/)
    expect(await inline.text()).toBe('data')
    const download = await call(moxy, `/api/uploads/${file.id}`)
    expect(download.headers.get('content-type')).toBe('text/html')
    expect(download.headers.get('content-disposition')).toMatch(/^attachment/)
    expect(await download.text()).toBe('hello')
    const result = await call(moxy, '/api/messages', { method: 'POST', body: { text: '', attachments: [image.id, file.id] } })
    expect(result.status).toBe(200)
    await moxy.loop.idle()
    expect(leader.requests.map(request => inboxPart(request.message))).toEqual([
      `Attachments:\n- ${imagePath} (image/png, 4 bytes)\n- ${filePath} (text/html, 5 bytes)`,
    ])
    expect(await json(call(moxy, '/api/state'))).toMatchObject({
      conversation: expect.arrayContaining([
        expect.objectContaining({
          type: 'user',
          text: '',
          attachments: [
            { id: image.id, name: 'test.png', type: 'image/png', size: 4, path: imagePath },
            { id: file.id, name: 'notes.html', type: 'text/html', size: 5, path: filePath },
          ],
        }),
      ]),
    })
    const withText = await call(moxy, '/api/messages', { method: 'POST', body: { text: 'Read this', attachments: [file.id] } })
    expect(withText.status).toBe(200)
    await moxy.loop.idle()
    expect(inboxPart(leader.requests.at(-1)!.message)).toBe(`Read this\n\nAttachments:\n- ${filePath} (text/html, 5 bytes)`)
  })

  it('rejects oversized uploads, excess attachments, and client-supplied file paths', async () => {
    const moxy = await startTestMoxy()
    const oversized = await upload(moxy, 'large.bin', '', new Uint8Array(25 * 1024 * 1024 + 1))
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toMatchObject({ error: expect.stringContaining('25 MB') })
    const streamed = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        `http://127.0.0.1:${moxy.webPort}/api/uploads`,
        {
          method: 'POST',
          headers: {
            'Tailscale-User-Login': ALLOWED_LOGIN,
            'Content-Type': 'application/octet-stream',
            'X-File-Name': 'stream.bin',
          },
        },
        res => {
          res.resume()
          res.on('end', () => resolve(res.statusCode))
          res.on('error', reject)
        },
      )
      req.on('error', reject)
      const mb = Buffer.alloc(1024 * 1024)
      for (let i = 0; i < 25; i++) req.write(mb)
      req.end('extra byte')
    })
    expect(streamed).toBe(413)
    expect(await readdir(moxy.paths.uploads)).toEqual([])
    const id = '12345678-1234-1234-1234-123456789abc'
    const tooMany = await call(moxy, '/api/messages', { method: 'POST', body: { text: 'hi', attachments: Array(11).fill(id) } })
    expect(tooMany.status).toBe(400)
    expect(await tooMany.json()).toMatchObject({ error: expect.stringContaining('10 files') })
    for (const attachment of ['../web-token', id]) {
      expect((await call(moxy, '/api/messages', { method: 'POST', body: { text: 'hi', attachments: [attachment] } })).status).toBe(400)
    }
    expect(moxy.conversation.conversation()).toEqual([])
  })
  it('protects machine discovery and keeps refresh separate from the cached read', async () => {
    const calls: string[] = []
    const list = {
      machines: [{ id: 'self', name: 'This machine', dnsName: '', self: true, online: false, moxy: 'yes' as const, url: null }],
      checkedAt: '2026-11-19T00:00:00.000Z',
      error: null,
    }
    const moxy = await startTestMoxy({
      machines: {
        get: async () => {
          calls.push('get')
          return list
        },
        refresh: async () => {
          calls.push('refresh')
          return list
        },
      },
    })
    expect((await call(moxy, '/api/machines', { headers: { 'Tailscale-User-Login': '' } })).status).toBe(401)
    expect((await call(moxy, '/api/machines', { headers: { 'Tailscale-User-Login': 'outsider@example.com' } })).status).toBe(403)
    expect(calls).toEqual([])
    expect(await json(call(moxy, '/api/machines'))).toEqual(list)
    expect(await json(call(moxy, '/api/machines?refresh=true'))).toEqual(list)
    expect(calls).toEqual(['get', 'refresh'])
  })

  it('owns notification devices by login, sends title-only ready notifications once, and does not replay them on restart', async () => {
    const home = await temporaryHome()
    const otherLogin = 'other@example.com'
    await writeFile(join(home, 'config.json'), JSON.stringify({ allowedLogins: [ALLOWED_LOGIN, otherLogin], quotaRefreshMinutes: 0 }))
    const sent: { endpoint: string; message: PushMessage }[] = []
    const sender: PushSender = async (subscription, payload) => {
      sent.push({ endpoint: subscription.endpoint, message: JSON.parse(payload) as PushMessage })
      return { ok: true }
    }
    const moxy = await startTestMoxy({ home, pushSender: sender })
    const phone = pushSubscription('phone')
    const response = await json<PushStatus>(call(moxy, '/api/push/subscribe', { method: 'POST', body: { subscription: phone } }))
    expect(response).toMatchObject({ devices: 1, subscribed: true, publicKey: expect.any(String) })
    expect(Object.keys(response).sort()).toEqual(['devices', 'publicKey', 'subscribed'])
    expect(await json(call(moxy, `/api/push?endpoint=${encodeURIComponent(phone.endpoint)}`))).toMatchObject({
      devices: 1,
      subscribed: true,
    })
    const otherHeaders = { 'Tailscale-User-Login': otherLogin }
    expect(await json(call(moxy, '/api/push', { headers: otherHeaders }))).toMatchObject({ devices: 0, subscribed: false })
    expect((await call(moxy, '/api/push/subscribe', { method: 'POST', body: { subscription: phone }, headers: otherHeaders })).status).toBe(
      400,
    )
    const otherPhone = pushSubscription('other-phone')
    await call(moxy, '/api/push/subscribe', { method: 'POST', body: { subscription: otherPhone }, headers: otherHeaders })
    await call(moxy, '/api/push/unsubscribe', { method: 'POST', body: { endpoint: otherPhone.endpoint } })
    expect(await json(call(moxy, '/api/push', { headers: otherHeaders }))).toMatchObject({ devices: 1 })
    expect(await json(call(moxy, '/api/push/test', { method: 'POST', body: {} }))).toEqual({ attempted: 1, sent: 1, failed: 0, errors: [] })
    expect(sent.map(message => message.endpoint)).toEqual([phone.endpoint])
    expect((await call(moxy, '/api/push/test', { method: 'POST', body: {}, headers: { Origin: 'https://evil.example' } })).status).toBe(403)
    const localToken = (await readFile(moxy.paths.webToken, 'utf8')).trim()
    expect(
      (
        await call(moxy, '/api/push/test', {
          method: 'POST',
          body: {},
          headers: { 'Tailscale-User-Login': '', Authorization: `Bearer ${localToken}` },
        })
      ).status,
    ).toBe(403)
    const task = await moxy.tasks.create({ title: 'Review the release', plan: 'Private implementation details' })
    await moxy.tasks.ready(task.id, { howToTry: 'Private output and paths' })
    await expect.poll(() => sent.length).toBe(3)
    expect(sent.slice(1).map(message => message.message)).toEqual([
      { title: task.title, taskId: task.id, path: `/?task=${task.id}` },
      { title: task.title, taskId: task.id, path: `/?task=${task.id}` },
    ])
    await moxy.tasks.ready(task.id, { howToTry: 'Private output and paths' })
    await moxy.stop()
    const restarted = await startTestMoxy({ home, pushSender: sender })
    expect(sent).toHaveLength(3)
    expect(await json(call(restarted, '/api/push'))).toMatchObject({ publicKey: response.publicKey, devices: 1 })
    await call(restarted, '/api/push/unsubscribe', { method: 'POST', body: { endpoint: phone.endpoint } })
    expect(await json(call(restarted, '/api/push/test', { method: 'POST', body: {} }))).toEqual({
      attempted: 0,
      sent: 0,
      failed: 0,
      errors: [],
    })
  })

  it('reports rejected notification tests without undoing task delivery', async () => {
    const moxy = await startTestMoxy({ pushSender: async () => ({ ok: false, status: 503, error: 'Push service unavailable' }) })
    await call(moxy, '/api/push/subscribe', { method: 'POST', body: { subscription: pushSubscription('failed') } })
    expect(await json(call(moxy, '/api/push/test', { method: 'POST', body: {} }))).toEqual({
      attempted: 1,
      sent: 0,
      failed: 1,
      errors: ['Push service unavailable'],
    })
    const task = await moxy.tasks.create({ title: 'Still ready' })
    expect(await moxy.tasks.ready(task.id, { howToTry: 'Read it' })).toMatchObject({ status: 'done' })
  })

  it('serves provider models, persists settings, and streams quota refreshes with protected writes', async () => {
    let reads = 0
    const moxy = await startTestMoxy({
      quotaReaders: {
        codex: async () => {
          reads++
          return {
            engine: 'codex',
            windows: [{ name: '5-hour', usedPercent: 42, resetsAt: null, stale: false, observedAt: new Date().toISOString() }],
          }
        },
        agy: async () => ({ engine: 'agy', windows: [] }),
        claude: async () => {
          throw new Error('Claude must only be explicitly refreshed in this test')
        },
      },
      models: {
        get: async engine => ({
          engine,
          models: [{ id: 'test-model', label: 'Test model', efforts: ['low', 'high'], defaultEffort: 'low', isDefault: true }],
          error: null,
        }),
      },
    })
    expect(await json(call(moxy, '/api/models/codex'))).toMatchObject({ engine: 'codex', models: [{ id: 'test-model' }] })
    expect((await call(moxy, '/api/models/unknown')).status).toBe(400)
    const stream = snapshots(moxy)
    expect((await until(stream, () => true)).settings).toEqual({ quotaRefreshMinutes: 5 })
    expect(
      (await call(moxy, '/api/quota/codex/refresh', { method: 'POST', body: {}, headers: { Origin: 'https://evil.example' } })).status,
    ).toBe(403)
    expect(reads).toBe(0)
    await call(moxy, '/api/quota/codex/refresh', { method: 'POST', body: {} })
    const refreshed = await until(stream, snapshot => snapshot.quota.some(quota => quota.engine === 'codex' && quota.windows.length > 0))
    expect(refreshed.quota.find(quota => quota.engine === 'codex')).toMatchObject({
      windows: [{ usedPercent: 42 }],
      error: null,
      busy: false,
    })
    expect(reads).toBe(1)
    expect(await json(call(moxy, '/api/settings', { method: 'POST', body: { quotaRefreshMinutes: 0 } }))).toEqual({
      quotaRefreshMinutes: 0,
    })
    expect((await until(stream, snapshot => snapshot.settings.quotaRefreshMinutes === 0)).revision).toBeGreaterThan(refreshed.revision)
    expect(JSON.parse(await (await import('node:fs/promises')).readFile(moxy.paths.config, 'utf8'))).toMatchObject({
      allowedLogins: [ALLOWED_LOGIN],
      quotaRefreshMinutes: 0,
    })
    expect((await call(moxy, '/api/settings', { method: 'POST', body: { quotaRefreshMinutes: -1 } })).status).toBe(400)
    expect((await call(moxy, '/api/quota/kimi/refresh', { method: 'POST', body: {} })).status).toBe(400)
    await stream.return(undefined)
  })

  it('answers allowed Tailscale logins and refuses everyone else', async () => {
    const moxy = await startTestMoxy()
    expect(await json(call(moxy, '/health', { headers: { 'Tailscale-User-Login': '' } }))).toEqual({ ok: true, app: 'moxy' })
    expect((await call(moxy, '/api/state', { headers: { 'Tailscale-User-Login': '' } })).status).toBe(401)
    expect((await call(moxy, '/api/state', { headers: { 'Tailscale-User-Login': 'someone@else.com' } })).status).toBe(403)
    expect(await json(call(moxy, '/api/state'))).toMatchObject({
      login: ALLOWED_LOGIN,
      leader: { engine: 'claude' },
      tasks: [],
      workers: [],
    })
  })

  it('refuses writes that are not JSON or come from another site', async () => {
    const moxy = await startTestMoxy()
    const crossSite = await call(moxy, '/api/messages', {
      method: 'POST',
      body: { text: 'hi' },
      headers: { Origin: 'https://evil.example' },
    })
    expect(crossSite.status).toBe(403)
    const form = await call(moxy, '/api/messages', { method: 'POST', headers: { 'Content-Type': 'text/plain' } })
    expect(form.status).toBe(403)
    expect(await json(call(moxy, '/api/messages', { method: 'POST', body: { text: '  ' } }))).toEqual({ error: 'text: text is required' })
  })

  it('streams a snapshot, then a new one after each change', async () => {
    const moxy = await startTestMoxy()
    const stream = snapshots(moxy)
    const first = await until(stream, () => true)
    expect(first.conversation).toEqual([])

    await call(moxy, '/api/messages', { method: 'POST', body: { text: 'Hello', id: 'a' } })
    const later = await until(stream, answered('You said: Hello'))
    expect(later.revision).toBeGreaterThan(first.revision)
    expect(later.conversation[0]).toMatchObject({ type: 'user', text: 'Hello', source: 'user:a' })
    await stream.return(undefined)
  })

  it('retries a failed Moxy turn and sets the next turn model and effort', async () => {
    const replies: LeaderReply[] = [
      { output: '', error: 'usage limit reached', nativeSessionId: null },
      { output: 'Hi!', error: null, nativeSessionId: 'native-1' },
    ]
    const leader: LeaderRunner = { run: async () => replies.shift()!, stop: async () => {} }
    const moxy = await startTestMoxy({ leaders: () => leader })
    const stream = snapshots(moxy)
    await call(moxy, '/api/messages', { method: 'POST', body: { text: 'Hello' } })
    const failed = await until(stream, snapshot =>
      snapshot.conversation.some(entry => entry.type === 'moxy' && entry.turn.status === 'failed'),
    )
    const turn = failed.conversation.find(entry => entry.type === 'moxy')
    expect(turn).toMatchObject({ turn: { error: 'usage limit reached', retried: false } })

    const settings = await json(
      call(moxy, '/api/leader/settings', { method: 'POST', body: { engine: 'claude', model: 'claude-opus-5-5', effort: 'high' } }),
    )
    expect(settings).toMatchObject({ engine: 'claude', model: 'claude-opus-5-5', effort: 'high' })
    await call(moxy, '/api/leader/retry', { method: 'POST', body: { turnId: turn?.type === 'moxy' ? turn.turn.id : -1 } })
    const retried = await until(stream, answered('Hi!'))
    expect(retried.conversation.at(-1)).toMatchObject({ turn: { model: 'claude-opus-5-5', effort: 'high' } })
    expect(retried.leader).toEqual({ engine: 'claude', model: 'claude-opus-5-5', effort: 'high' })
    await stream.return(undefined)
  })

  it('says what is wrong with an unknown worker or route', async () => {
    const moxy = await startTestMoxy()
    expect(await json(call(moxy, '/api/workers/nope'))).toEqual({ error: 'unknown worker nope' })
    expect(await json(call(moxy, '/api/workers/nope/activity'))).toEqual({ error: 'unknown worker nope' })
    expect((await call(moxy, '/api/nothing')).status).toBe(404)
  })

  it('serves the web app once it is built', async () => {
    const staticDir = join(await temporaryHome(), 'dist')
    const moxy = await startTestMoxy({ staticDir })
    expect((await call(moxy, '/')).status).toBe(503)
    await mkdir(staticDir)
    await writeFile(join(staticDir, 'index.html'), '<title>Moxy</title>')
    const page = await call(moxy, '/')
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<title>Moxy</title>')
  })

  it('stops only when asked from its own machine', async () => {
    const moxy = await startTestMoxy()
    const remote = await call(moxy, '/api/shutdown', { method: 'POST', body: {} })
    expect(remote.status).toBe(403)
    const localToken = (await readFile(moxy.paths.webToken, 'utf8')).trim()
    const local = await json(
      call(moxy, '/api/shutdown', {
        method: 'POST',
        body: {},
        headers: { 'Tailscale-User-Login': '', Authorization: `Bearer ${localToken}` },
      }),
    )
    expect(local).toEqual({ pid: process.pid })
    await moxy.stopped
    await expect(fetch(`http://127.0.0.1:${moxy.webPort}/health`)).rejects.toThrow()
  })
})
