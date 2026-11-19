import { describe, expect, it } from 'vitest'

import type { Moxy } from '../app.js'
import type { Snapshot } from '../contracts/api.js'
import type { LeaderReply, LeaderRunner } from '../runtime/leaders/leader.js'
import { ALLOWED_LOGIN, startTestMoxy } from '../testing/test-moxy.js'

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

    const settings = await json(call(moxy, '/api/leader/settings', { method: 'POST', body: { model: 'claude-opus-5-5', effort: 'high' } }))
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
    expect((await call(moxy, '/api/nothing')).status).toBe(404)
    expect((await call(moxy, '/')).status).toBe(503)
  })
})
