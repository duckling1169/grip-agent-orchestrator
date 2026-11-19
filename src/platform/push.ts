// Web Push uses https://github.com/web-push-libs/web-push.

import { readFile } from 'node:fs/promises'

import { generateVAPIDKeys, sendNotification } from 'web-push'

import type { PushMessage, PushReport, PushStatus, PushSubscriptionJson } from '../contracts/push.js'
import { errorText } from '../errors.js'
import { writeFileAtomic } from '../files.js'

type VapidKeys = { publicKey: string; privateKey: string }
type Device = PushSubscriptionJson & { login: string }
type PushFile = { vapid: VapidKeys; devices: Device[] }
type PushResult = { ok: true } | { ok: false; status: number; error: string }
export type PushSender = (
  subscription: PushSubscriptionJson,
  payload: string,
  options: { ttlSeconds: number; timeoutMs: number },
) => Promise<PushResult>
export type PushOptions = {
  path: string
  allowedLogins: () => readonly string[]
  sender?: PushSender
  timeoutMs?: number
  concurrency?: number
}

export class PushNotifier {
  private writes = Promise.resolve()
  private readonly sender: PushSender
  private readonly timeoutMs: number
  private readonly concurrency: number
  private readonly queue: (() => void)[] = []
  private active = 0
  private closed = false
  private readonly pending = new Set<Promise<PushReport>>()

  private constructor(
    private readonly options: PushOptions,
    private readonly file: PushFile,
  ) {
    this.sender = options.sender ?? webPushSender(file.vapid)
    this.timeoutMs = Math.max(1, Math.min(15000, options.timeoutMs ?? 15000))
    this.concurrency = Math.max(1, Math.min(4, Math.floor(options.concurrency ?? 4)))
  }

  static async open(options: PushOptions): Promise<PushNotifier> {
    let file: PushFile
    let created = false
    try {
      const saved = JSON.parse(await readFile(options.path, 'utf8')) as PushFile
      if (
        !saved?.vapid ||
        typeof saved.vapid.publicKey !== 'string' ||
        typeof saved.vapid.privateKey !== 'string' ||
        !Array.isArray(saved.devices)
      ) {
        throw new Error('Invalid saved push configuration')
      }
      file = {
        vapid: saved.vapid,
        devices: saved.devices.filter(validDevice).map(device => ({ ...device, login: device.login.toLowerCase() })),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      file = { vapid: generateVAPIDKeys(), devices: [] }
      created = true
    }
    const notifier = new PushNotifier(options, file)
    if (created) await notifier.save()
    return notifier
  }

  get publicKey(): string {
    return this.file.vapid.publicKey
  }

  status(login: string, endpoint?: string): PushStatus {
    login = login.toLowerCase()
    this.assertAllowed(login)
    const devices = this.file.devices.filter(device => device.login === login)
    return { publicKey: this.publicKey, devices: devices.length, subscribed: devices.some(device => device.endpoint === endpoint) }
  }

  async subscribe(login: string, subscription: PushSubscriptionJson): Promise<void> {
    if (this.closed) throw new Error('Push notifier is closed')
    login = login.toLowerCase()
    this.assertAllowed(login)
    if (!validSubscription(subscription)) throw new Error('Invalid push subscription')
    const existing = this.file.devices.find(device => device.endpoint === subscription.endpoint)
    if (existing && existing.login !== login) throw new Error('This push subscription belongs to another login')
    if (!existing && this.file.devices.length >= 256) throw new Error('Push device limit reached')
    const device: Device = { login, endpoint: subscription.endpoint, keys: { ...subscription.keys } }
    this.file.devices = [...this.file.devices.filter(saved => saved.endpoint !== device.endpoint), device]
    await this.save()
  }

  async unsubscribe(login: string, endpoint: string): Promise<void> {
    if (this.closed) throw new Error('Push notifier is closed')
    login = login.toLowerCase()
    this.assertAllowed(login)
    this.file.devices = this.file.devices.filter(device => device.login !== login || device.endpoint !== endpoint)
    await this.save()
  }

  test(login: string): Promise<PushReport> {
    login = login.toLowerCase()
    this.assertAllowed(login)
    return this.broadcast({ title: 'Moxy notification test', path: '/' }, login)
  }

  ready(task: { id: string; title: string }): Promise<PushReport> {
    return this.broadcast({ title: task.title.slice(0, 200), taskId: task.id, path: `/?task=${encodeURIComponent(task.id)}` })
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.all(this.pending)
    await this.writes
  }

  private assertAllowed(login: string): void {
    if (!this.allowed(login)) throw new Error('Login is not allowed to manage notifications')
  }

  private allowed(login: string): boolean {
    return this.options.allowedLogins().some(allowed => allowed.toLowerCase() === login.toLowerCase())
  }

  private broadcast(message: PushMessage, login?: string): Promise<PushReport> {
    if (this.closed) return Promise.resolve({ attempted: 0, sent: 0, failed: 0, errors: [] })
    const devices = this.file.devices.filter(device => (login === undefined || device.login === login) && this.allowed(device.login))
    const work = Promise.all(devices.map(device => this.enqueue(() => this.deliver(device, message)))).then(results => {
      const attempted = results.filter(result => result !== null)
      const errors = attempted.flatMap(result => (result!.ok ? [] : [(result as { error: string }).error]))
      return { attempted: attempted.length, sent: attempted.length - errors.length, failed: errors.length, errors }
    })
    this.pending.add(work)
    void work.finally(() => this.pending.delete(work))
    return work
  }

  private enqueue(work: () => Promise<PushResult | null>): Promise<PushResult | null> {
    if (this.queue.length >= 1024) return Promise.resolve({ ok: false, status: 0, error: 'Push queue is full' })
    return new Promise(resolve => {
      const run = () => {
        this.active++
        void work()
          .then(resolve)
          .catch(error => resolve({ ok: false, status: 0, error: errorText(error).slice(0, 200) }))
          .finally(() => {
            this.active--
            this.queue.shift()?.()
          })
      }
      if (this.active < this.concurrency) run()
      else this.queue.push(run)
    })
  }

  private async deliver(device: Device, message: PushMessage): Promise<PushResult | null> {
    if (this.closed || !this.allowed(device.login) || !this.file.devices.includes(device)) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    let result: PushResult
    try {
      result = await Promise.race([
        this.sender(device, JSON.stringify(message), { ttlSeconds: 86400, timeoutMs: this.timeoutMs }),
        new Promise<PushResult>(resolve => {
          timer = setTimeout(() => resolve({ ok: false, status: 0, error: 'Push send timed out' }), this.timeoutMs)
        }),
      ])
    } catch (error) {
      result = { ok: false, status: 0, error: errorText(error).slice(0, 200) }
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (!result.ok && (result.status === 404 || result.status === 410)) {
      this.file.devices = this.file.devices.filter(saved => saved !== device)
      await this.save()
    }
    return result
  }

  private save(): Promise<void> {
    const text = `${JSON.stringify(this.file, null, 2)}\n`
    const write = this.writes.then(() => writeFileAtomic(this.options.path, text, 0o600))
    this.writes = write.catch(() => undefined)
    return write
  }
}

function validDevice(value: unknown): value is Device {
  return validSubscription(value) && typeof (value as Device).login === 'string'
}

function validSubscription(value: unknown): value is PushSubscriptionJson {
  if (typeof value !== 'object' || value === null) return false
  const subscription = value as PushSubscriptionJson
  if (typeof subscription.endpoint !== 'string' || subscription.endpoint.length > 4096 || !subscription.keys) return false
  if (!validKey(subscription.keys.p256dh, 65) || !validKey(subscription.keys.auth, 16)) return false
  if (Buffer.from(subscription.keys.p256dh, 'base64url')[0] !== 4) return false
  try {
    const url = new URL(subscription.endpoint)
    const host = url.hostname
    const known =
      host === 'fcm.googleapis.com' ||
      host === 'updates.push.services.mozilla.com' ||
      /^[a-z0-9-]+\.push\.services\.mozilla\.com$/.test(host) ||
      host === 'web.push.apple.com' ||
      /^[a-z0-9-]+\.notify\.windows\.com$/.test(host)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && known
  } catch {
    return false
  }
}

function validKey(value: unknown, length: number): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+={0,2}$/.test(value) && Buffer.from(value, 'base64url').length === length
}

export function webPushSender(vapid: VapidKeys, send: typeof sendNotification = sendNotification): PushSender {
  return async (subscription, payload, options) => {
    try {
      await send(subscription, payload, {
        vapidDetails: { subject: 'https://github.com/duckling1169/moxy', ...vapid },
        TTL: options.ttlSeconds,
        timeout: options.timeoutMs,
        urgency: 'normal',
      })
      return { ok: true }
    } catch (error) {
      const status = typeof (error as { statusCode?: unknown })?.statusCode === 'number' ? (error as { statusCode: number }).statusCode : 0
      return { ok: false, status, error: status ? `Push service returned ${status}` : errorText(error).slice(0, 200) }
    }
  }
}
