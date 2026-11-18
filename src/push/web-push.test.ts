import { describe, expect, it } from 'vitest'
import { generateRequestDetails, WebPushError } from 'web-push'

import { createVapidKeys, pushOptions, webPushSender } from './web-push.js'
import type { PushSubscriptionJson } from './web-push.js'

// A real device key and auth secret, from RFC 8291's worked example.
const subscription: PushSubscriptionJson = {
  endpoint: 'https://web.push.apple.com/QGr0XYZ',
  keys: {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  },
}

describe('pushOptions', () => {
  it('builds an encrypted request signed with Grip’s key, with its expiry and no topic', () => {
    const keys = createVapidKeys()
    const request = generateRequestDetails(subscription, '{"title":"Done"}', pushOptions(keys, { ttlSeconds: 3600 }))
    expect(request.endpoint).toBe(subscription.endpoint)
    expect(request.headers).toMatchObject({ TTL: 3600, Urgency: 'normal', 'Content-Encoding': 'aes128gcm' })
    // Apple refuses a Topic header (BadWebPushTopic), so Grip never sends one.
    expect(request.headers).not.toHaveProperty('Topic')
    expect(String(request.headers.Authorization)).toMatch(new RegExp(`^vapid t=.+, k=${keys.publicKey}$`))
    // Salt, record size, key length and the server's key, then the sealed payload and its tag.
    expect((request.body as Buffer).length).toBe(16 + 4 + 1 + 65 + '{"title":"Done"}'.length + 1 + 16)
  })
})

describe('webPushSender', () => {
  it('sends through the library and reports success', async () => {
    const calls: unknown[] = []
    const send = webPushSender(createVapidKeys(), (async (...args: unknown[]) => {
      calls.push(args)
      return { statusCode: 201, body: '', headers: {} }
    }) as never)
    expect(await send(subscription, 'x', { ttlSeconds: 60 })).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
  })

  it('reports a device that unsubscribed as gone, and other refusals as errors', async () => {
    const failing = (status: number, body: string) =>
      webPushSender(createVapidKeys(), (async () => {
        throw new WebPushError('Received unexpected response code', status, {}, body, subscription.endpoint)
      }) as never)
    expect(await failing(410, 'expired')(subscription, 'x', { ttlSeconds: 60 })).toEqual({
      ok: false,
      status: 410,
      gone: true,
      error: 'expired',
    })
    expect(await failing(403, 'BadJwtToken')(subscription, 'x', { ttlSeconds: 60 })).toEqual({
      ok: false,
      status: 403,
      gone: false,
      error: 'BadJwtToken',
    })
  })
})
