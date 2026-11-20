import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { Moxy } from '../app.js'
import type { Snapshot } from '../contracts/api.js'
import * as commands from '../exec.js'
import type { LeaderReply, LeaderRunner } from '../runtime/leaders/leader.js'
import { temporaryHome } from '../testing/harness.js'
import { ALLOWED_LOGIN, startTestMoxy, webCall as call, webJson as json } from '../testing/test-moxy.js'

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

  it('explains when the allowlist denies every Tailscale login', async () => {
    const home = await temporaryHome()
    await writeFile(join(home, 'config.json'), JSON.stringify({ allowedLogins: [] }))
    const moxy = await startTestMoxy({ home })
    const response = await call(moxy, '/api/events')
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: `No Tailscale logins are allowed. Add ${ALLOWED_LOGIN} to allowedLogins in Moxy's config.json.`,
    })
  })

  it('refuses writes that are not JSON or come from another site', async () => {
    const moxy = await startTestMoxy()
    const host = `127.0.0.1:${moxy.webPort}`
    const blocked: Record<string, string>[] = [
      { Origin: `https://${host}` },
      { Origin: `http://${host}/path` },
      { Origin: 'http://evil.example', 'X-Forwarded-Host': 'evil.example' },
    ]
    for (const headers of blocked) {
      expect((await call(moxy, '/api/messages', { method: 'POST', body: { text: 'hi' }, headers })).status).toBe(403)
    }
    expect(
      (await call(moxy, '/api/messages', { method: 'POST', body: { text: 'hi' }, headers: { Origin: `http://${host}` } })).status,
    ).toBe(200)
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

  it.each(['fails', 'is missing'])(
    'accepts same-origin HTTPS tailnet writes from an allowed login when the Tailscale CLI %s',
    async failure => {
      const moxy = await startTestMoxy()
      const lookup = vi.spyOn(commands, 'exec')
      if (failure === 'fails') lookup.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'status unavailable' })
      else lookup.mockRejectedValueOnce(Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' }))
      const host = 'moxy.tail-example.ts.net'
      const origin = `https://${host}`
      const post = (headers: Record<string, string>) =>
        new Promise<number | undefined>((resolve, reject) => {
          const req = request(
            `http://127.0.0.1:${moxy.webPort}/api/messages`,
            { method: 'POST', headers: { 'Content-Type': 'application/json', 'Tailscale-User-Login': ALLOWED_LOGIN, ...headers } },
            res => {
              res.resume()
              res.on('end', () => resolve(res.statusCode))
              res.on('error', reject)
            },
          )
          req.on('error', reject)
          req.end('{"text":"Hello"}')
        })
      try {
        expect(await post({ Host: host, Origin: origin, 'Tailscale-User-Login': '' })).toBe(401)
        expect(await post({ Host: host, Origin: origin, 'Tailscale-User-Login': 'outsider@example.com' })).toBe(403)
        expect(lookup).not.toHaveBeenCalled()

        expect(await post({ Host: host, Origin: origin })).toBe(200)
        expect(lookup).toHaveBeenCalledWith('tailscale', ['status', '--json'], { timeoutMs: 3000 })
        const blocked: Record<string, string>[] = [
          { Host: host },
          { Host: host, Origin: `http://${host}` },
          { Host: host, Origin: `${origin}:444` },
          { Host: host, Origin: 'https://other.tail-example.ts.net', 'X-Forwarded-Host': 'other.tail-example.ts.net' },
          { Host: 'evil.example', Origin: 'https://evil.example' },
        ]
        for (const headers of blocked) {
          expect(await post(headers)).toBe(403)
        }
        expect(lookup).toHaveBeenCalledTimes(1)
      } finally {
        lookup.mockRestore()
      }
    },
  )

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
    for (const path of ['/api/workers/nope', '/api/workers/nope/activity', '/api/tasks/nope']) {
      const response = await call(moxy, path)
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('nope') as unknown })
    }
    expect((await call(moxy, '/api/leader/retry', { method: 'POST', body: { turnId: 999 } })).status).toBe(404)
    expect((await call(moxy, '/api/nothing')).status).toBe(404)
  })

  it('logs unexpected failures and returns a generic server error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const moxy = await startTestMoxy({
        models: {
          get: async () => {
            throw new Error('private discovery error')
          },
        },
      })
      const response = await call(moxy, '/api/models/codex')
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'internal error' })
      expect(log).toHaveBeenCalledWith(expect.stringContaining('private discovery error'))
    } finally {
      log.mockRestore()
    }
  })

  it('returns a public validation error for malformed JSON', async () => {
    const moxy = await startTestMoxy()
    const response = await fetch(`http://127.0.0.1:${moxy.webPort}/api/messages`, {
      method: 'POST',
      headers: { 'Tailscale-User-Login': ALLOWED_LOGIN, 'Content-Type': 'application/json' },
      body: '{',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'request body is not JSON' })
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
