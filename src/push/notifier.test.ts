import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { RunStore } from '../runs/store.js'
import { PushNotifier } from './notifier.js'
import type { PushMessage } from './notifier.js'
import type { PushResult, PushSender } from './web-push.js'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const phone = { endpoint: 'https://web.push.apple.com/phone', keys: { p256dh: 'p', auth: 'a' } }
const laptop = { endpoint: 'https://fcm.googleapis.com/fcm/send/laptop', keys: { p256dh: 'p2', auth: 'a2' } }

async function setup(answer: (endpoint: string) => PushResult = () => ({ ok: true })) {
  const dir = await mkdtemp(join(tmpdir(), 'grip-push-'))
  dirs.push(dir)
  const sent: { endpoint: string; message: PushMessage }[] = []
  const sender: PushSender = async (subscription, payload, options) => {
    sent.push({
      endpoint: subscription.endpoint,
      message: JSON.parse(payload) as PushMessage,
    })
    return answer(subscription.endpoint)
  }
  const logs: string[] = []
  const path = join(dir, 'push.json')
  const open = () => PushNotifier.open({ path, allowedLogins: ['you@github'], sender, log: line => logs.push(line) })
  return { dir, path, sent, logs, open, push: await open() }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

describe('PushNotifier', () => {
  it('makes VAPID keys once and keeps them, with the devices, readable only by you', async () => {
    const t = await setup()
    await t.push.subscribe('you@github', phone)
    const again = await t.open()
    expect(again.publicKey).toBe(t.push.publicKey)
    expect(again.device(phone.endpoint, 'you@github')).toEqual({ muted: [] })
    const saved = JSON.parse(await readFile(t.path, 'utf8')) as { vapid: { privateKey: string } }
    expect(saved.vapid.privateKey).toBeTruthy()
    if (process.platform !== 'win32') expect((await stat(t.path)).mode & 0o777).toBe(0o600)
  })

  it('notifies when a working run finishes or fails, and not when it is stopped', async () => {
    const t = await setup()
    await t.push.subscribe('you@github', phone)
    const store = await RunStore.open(t.dir)
    t.push.watchRuns(store)

    const run = await store.create({
      title: 'Fix login',
      engine: 'codex',
      folder: '/code',
      cwd: '/code',
      repo: null,
      brief: { kind: 'text', text: 'Fix login' },
    })
    await store.startTurn(run.id, 'Fix login')
    await store.endTurn(run.id, 1, { output: 'Done' })
    await store.startTurn(run.id, 'Add a test')
    await store.endTurn(run.id, 2, { output: '', error: 'tests fail' })
    await store.startTurn(run.id, 'Try again')
    await store.markStopped(run.id)
    await settle()

    expect(t.sent).toEqual([
      {
        endpoint: phone.endpoint,
        message: { title: 'Fix login', body: 'GPT worker finished', url: `/#/runs/${run.id}`, tag: run.id },
      },
      {
        endpoint: phone.endpoint,
        message: { title: 'Fix login', body: 'GPT worker failed', url: `/#/runs/${run.id}`, tag: run.id },
      },
    ])
  })

  it('skips devices that muted the event or whose login is no longer allowed', async () => {
    const t = await setup()
    await t.push.subscribe('you@github', phone, ['run-done'])
    await t.push.subscribe('you@github', laptop)
    await t.push.subscribe('someone@github', { ...laptop, endpoint: 'https://fcm.googleapis.com/fcm/send/other' })
    const message = { title: 'Fix login', body: 'GPT worker finished', url: '/', tag: 'r-1' }
    await t.push.notify('run-done', message)
    expect(t.sent.map(s => s.endpoint)).toEqual([laptop.endpoint])

    await t.push.setMuted(laptop.endpoint, 'you@github', ['run-done', 'claw-rolled-back'])
    await t.push.setMuted(phone.endpoint, 'you@github', [])
    t.sent.length = 0
    await t.push.notify('run-done', message)
    expect(t.sent.map(s => s.endpoint)).toEqual([phone.endpoint])
  })

  it('notifies when a Claw update is rolled back', async () => {
    const t = await setup()
    await t.push.subscribe('you@github', phone)
    const supervisor = new EventEmitter<{ 'rolled-back': [{ attempted: string; to: string; reason: string }] }>()
    t.push.watchClaw(supervisor)
    supervisor.emit('rolled-back', { attempted: '7.24.0', to: '7.23.4', reason: 'health check' })
    await settle()
    expect(t.sent[0]?.message).toEqual({
      title: 'Claw update rolled back',
      body: '7.24.0 failed its checks, so Grip is back on 7.23.4.',
      url: '/',
      tag: 'claw-update',
    })
  })

  it('says when this machine goes to sleep or shuts down, and has sent it by the time it returns', async () => {
    const t = await setup()
    await t.push.subscribe('you@github', phone)
    await t.push.subscribe('you@github', laptop)
    await t.push.setMuted(laptop.endpoint, 'you@github', ['principal-offline'])
    await t.push.offline('windows-pc', 'sleep')
    expect(t.sent).toEqual([
      {
        endpoint: phone.endpoint,
        message: {
          title: 'windows-pc is going to sleep',
          body: 'Grip and its workers are offline until it is back.',
          url: '/',
          tag: 'principal-offline',
        },
      },
    ])
    await t.push.offline('windows-pc', 'logoff')
    expect(t.sent[1]?.message.title).toBe('You signed out of windows-pc')
  })

  it('drops a device the push service says is gone, and logs other failures', async () => {
    const t = await setup(endpoint =>
      endpoint === phone.endpoint
        ? { ok: false, status: 410, gone: true, error: 'expired' }
        : { ok: false, status: 500, gone: false, error: 'busy' },
    )
    await t.push.subscribe('you@github', phone)
    await t.push.subscribe('you@github', laptop)
    await t.push.notify('run-failed', { title: 'x', body: 'y', url: '/', tag: 'r-1' })
    expect(t.push.device(phone.endpoint, 'you@github')).toBeNull()
    expect(t.push.device(laptop.endpoint, 'you@github')).toEqual({ muted: [] })
    expect(t.logs.sort()).toEqual(['a device turned notifications off (410); removed it', 'push failed (500): busy'])
    expect(await t.push.test('you@github')).toEqual({ devices: 1, sent: 0, errors: ['busy'] })
    await expect(t.push.test('someone@github')).rejects.toThrow('No device has notifications on')
  })

  it('refuses a push endpoint that is not https, and settings for a device it does not know', async () => {
    const t = await setup()
    await expect(t.push.subscribe('you@github', { ...phone, endpoint: 'http://127.0.0.1:9/push' })).rejects.toThrow('https')
    await expect(t.push.setMuted(phone.endpoint, 'you@github', [])).rejects.toThrow('not on for this device')
    // Another login cannot read or change your device.
    await t.push.subscribe('you@github', phone)
    expect(t.push.device(phone.endpoint, 'someone@github')).toBeNull()
    await t.push.unsubscribe(phone.endpoint, 'you@github')
    expect(t.push.device(phone.endpoint, 'you@github')).toBeNull()
  })
})
