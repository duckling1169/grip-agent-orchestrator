import { createECDH } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { generateRequestDetails, generateVAPIDKeys } from 'web-push'

import { PushNotifier, webPushSender } from './push.js'
import type { PushSender } from './push.js'

const folders: string[] = []
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true, maxRetries: 5 })
})

const subscription = (id: string) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
  keys: {
    p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'),
    auth: Buffer.alloc(16, 2).toString('base64url'),
  },
})

async function setup(sender: PushSender = async () => ({ ok: true }), extras = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'moxy-push-test-'))
  folders.push(folder)
  const access = { logins: ['alice', 'bob', 'charlie'] }
  const path = join(folder, 'push.json')
  const open = () => PushNotifier.open({ path, allowedLogins: () => access.logins, sender, ...extras })
  return { push: await open(), open, access, path }
}

describe('PushNotifier', () => {
  it('uses official encrypted and VAPID-signed requests with bounded TTL and no Topic header', async () => {
    const curve = createECDH('prime256v1')
    const device = subscription('signed')
    device.keys.p256dh = curve.generateKeys().toString('base64url')
    const sender = webPushSender(generateVAPIDKeys(), async (subscription, payload, options) => {
      const request = generateRequestDetails(subscription, payload ?? '', options)
      expect(request.method).toBe('POST')
      expect(Number(request.headers.TTL)).toBe(86400)
      expect(request.headers.Authorization).toMatch(/^vapid /)
      expect(request.headers.Topic).toBeUndefined()
      expect(request.body).toBeInstanceOf(Buffer)
      expect(request.body?.toString()).not.toContain('notification title')
      expect(options?.timeout).toBe(15000)
      return { statusCode: 201, body: '', headers: {} }
    })
    expect(
      await sender(device, JSON.stringify({ title: 'notification title', path: '/' }), { ttlSeconds: 86400, timeoutMs: 15000 }),
    ).toEqual({ ok: true })
  })

  it('persists VAPID keys and subscriptions, exposing only the current login device count', async () => {
    const { push, open, path } = await setup()
    await push.subscribe('ALICE', subscription('a'))
    await push.subscribe('bob', subscription('b'))
    const again = await open()
    expect(again.publicKey).toBe(push.publicKey)
    expect(again.status('ALICE', subscription('a').endpoint)).toEqual({ publicKey: push.publicKey, devices: 1, subscribed: true })
    expect(again.status('bob', subscription('a').endpoint).subscribed).toBe(false)
    expect(JSON.parse(await readFile(path, 'utf8')).vapid.privateKey).toBeTruthy()
  })

  it('rejects unsafe endpoints and invalid keys without taking another login device', async () => {
    const { push } = await setup()
    for (const endpoint of [
      'http://fcm.googleapis.com/a',
      'https://localhost/a',
      'https://127.0.0.1/a',
      'https://fcm.googleapis.com.evil.test/a',
      'https://fcm.googleapis.com:444/a',
      'https://user:pass@fcm.googleapis.com/a',
    ]) {
      await expect(push.subscribe('alice', { ...subscription('a'), endpoint })).rejects.toThrow('push subscription')
    }
    await expect(push.subscribe('alice', { ...subscription('a'), keys: { p256dh: 'bad', auth: 'bad' } })).rejects.toThrow(
      'push subscription',
    )
    await push.subscribe('alice', subscription('a'))
    await expect(push.subscribe('bob', subscription('a'))).rejects.toThrow('another login')
    await push.unsubscribe('bob', subscription('a').endpoint)
    expect(push.status('alice').devices).toBe(1)
  })

  it('reports attempts, successes and errors truthfully, removes expired devices and sends tests only to the current login', async () => {
    const calls: string[] = []
    const { push } = await setup(async (device, payload, options) => {
      calls.push(device.endpoint)
      expect(JSON.parse(payload)).toEqual({ title: 'Moxy notification test', path: '/' })
      expect(options).toMatchObject({ ttlSeconds: 86400, timeoutMs: 15000 })
      if (device.endpoint.endsWith('/gone')) return { ok: false, status: 410, error: 'expired' }
      if (device.endpoint.endsWith('/fail')) throw new Error('network unavailable')
      return { ok: true }
    })
    for (const id of ['ok', 'gone', 'fail']) await push.subscribe('alice', subscription(id))
    await push.subscribe('bob', subscription('bob'))
    expect(await push.test('alice')).toEqual({ attempted: 3, sent: 1, failed: 2, errors: ['expired', 'network unavailable'] })
    expect(calls).toHaveLength(3)
    expect(push.status('alice').devices).toBe(2)
    expect(await push.test('charlie')).toEqual({ attempted: 0, sent: 0, failed: 0, errors: [] })
    expect(() => push.test('nobody')).toThrow('not allowed')
  })

  it('checks allowed logins before each queued send and restricts ready payloads to title and safe task navigation', async () => {
    const payloads: unknown[] = []
    let revoke = () => {}
    const { push, access } = await setup(
      async (_device, payload) => {
        payloads.push(JSON.parse(payload))
        revoke()
        return { ok: true }
      },
      { concurrency: 1 },
    )
    revoke = () => {
      access.logins = ['alice']
    }
    await push.subscribe('alice', subscription('a'))
    await push.subscribe('bob', subscription('b'))
    expect(await push.ready({ id: '../bad?x', title: 'Ready title', output: 'secret' } as { id: string; title: string })).toEqual({
      attempted: 1,
      sent: 1,
      failed: 0,
      errors: [],
    })
    expect(payloads).toEqual([{ title: 'Ready title', taskId: '../bad?x', path: '/?task=..%2Fbad%3Fx' }])
    expect(() => push.test('bob')).toThrow('not allowed')
  })

  it('removes devices the service reports missing and rejects revoked login access', async () => {
    const { push, access, open } = await setup(async () => ({ ok: false, status: 404, error: 'missing' }))
    await push.subscribe('alice', subscription('a'))
    expect(await push.ready({ id: 'task', title: 'Ready' })).toEqual({ attempted: 1, sent: 0, failed: 1, errors: ['missing'] })
    expect((await open()).status('alice').devices).toBe(0)
    access.logins = []
    expect(() => push.status('alice')).toThrow('not allowed')
    await expect(push.subscribe('alice', subscription('a'))).rejects.toThrow('not allowed')
    await expect(push.unsubscribe('alice', subscription('a').endpoint)).rejects.toThrow('not allowed')
  })

  it('bounds stalled sends, global concurrency and shutdown', async () => {
    let active = 0
    let peak = 0
    const { push } = await setup(
      async device => {
        active++
        peak = Math.max(peak, active)
        if (device.endpoint.endsWith('/stall')) return new Promise(() => {})
        await new Promise(resolve => setTimeout(resolve, 5))
        active--
        return { ok: true }
      },
      { timeoutMs: 30, concurrency: 1 },
    )
    await push.subscribe('alice', subscription('ok'))
    const [one, two] = await Promise.all([push.test('alice'), push.test('alice')])
    expect(one.sent + two.sent).toBe(2)
    expect(peak).toBe(1)
    await push.unsubscribe('alice', subscription('ok').endpoint)
    await push.subscribe('alice', subscription('stall'))
    await push.subscribe('alice', subscription('queued'))
    const pending = push.test('alice')
    await push.close()
    expect(await pending).toEqual({ attempted: 1, sent: 0, failed: 1, errors: ['Push send timed out'] })
    expect((await push.test('alice')).attempted).toBe(0)
    await expect(push.subscribe('alice', subscription('new'))).rejects.toThrow('closed')
    await expect(push.unsubscribe('alice', subscription('stall').endpoint)).rejects.toThrow('closed')
  })
})
