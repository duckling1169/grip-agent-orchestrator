import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { PushMessage, PushStatus } from '../contracts/push.js'
import type { PushSender } from '../platform/push.js'
import { temporaryHome } from '../testing/harness.js'
import { ALLOWED_LOGIN, startTestMoxy, webCall as call, webJson as json } from '../testing/test-moxy.js'

const pushSubscription = (id: string) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
  keys: {
    p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'),
    auth: Buffer.alloc(16, 2).toString('base64url'),
  },
})

describe('web notifications', () => {
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
    expect(response).toMatchObject({ devices: 1, subscribed: true, publicKey: expect.any(String) as unknown })
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
})
