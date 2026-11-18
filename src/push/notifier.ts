import type { EventEmitter } from 'node:events'

import { readJson, writeFileAtomic } from '../fs-util.js'
import { ENGINE_NAMES } from '../runs/store.js'
import type { Run, RunStatus } from '../runs/store.js'
import { createVapidKeys, webPushSender } from './web-push.js'
import type { PushSender, PushSubscriptionJson, VapidKeys } from './web-push.js'

/**
 * What Grip notifies about (DESIGN §13). Each device mutes any of them. Admin requests come with
 * the admin flow.
 */
export const PUSH_EVENTS = ['run-done', 'run-failed', 'claw-rolled-back', 'principal-offline'] as const
export type PushEvent = (typeof PUSH_EVENTS)[number]

/** A notification's whole payload: a title and a line, never code or output. */
export type PushMessage = { title: string; body: string; url: string; tag: string }

type Device = PushSubscriptionJson & { login: string; addedAt: string; muted: PushEvent[] }
type PushFile = { vapid: VapidKeys; devices: Device[] }

type RunEvents = { change: [Run] }
type RolledBack = { attempted: string; to: string; reason: string }

export type PushNotifierOptions = {
  /** `~/.grip/push.json`: Grip's VAPID keys and the devices that turned notifications on. */
  path: string
  /** Only devices added by a login that is still allowed get notifications. */
  allowedLogins: readonly string[]
  /** How messages go out; the real push services unless a test stands in. */
  sender?: PushSender
  /** How long a push service keeps trying a device that is off; a day unless settings say otherwise. */
  expirySeconds?: number
  log?: (line: string) => void
}

/**
 * Web Push to the devices that turned notifications on in the app. Keys are made on first use
 * and kept, so subscriptions survive restarts. A device the push service says is gone is dropped.
 */
export class PushNotifier {
  private writes = Promise.resolve()

  private constructor(
    private readonly options: PushNotifierOptions,
    private readonly file: PushFile,
    private readonly send: PushSender,
  ) {}

  static async open(options: PushNotifierOptions): Promise<PushNotifier> {
    const stored = await readJson<PushFile>(options.path)
    // Without a usable key pair, make one. Devices subscribed for an older key cannot receive
    // messages signed with a new one, so they go too; the app asks again when you open Settings.
    const usable = Boolean(stored?.vapid?.publicKey && stored.vapid.privateKey)
    const file: PushFile = usable ? { vapid: stored!.vapid, devices: stored!.devices ?? [] } : { vapid: createVapidKeys(), devices: [] }
    const notifier = new PushNotifier(options, file, options.sender ?? webPushSender(file.vapid))
    if (!usable) await notifier.save()
    return notifier
  }

  /** The key the app passes to `pushManager.subscribe()`. */
  get publicKey(): string {
    return this.file.vapid.publicKey
  }

  /** This device's settings, or null when it has not turned notifications on here. */
  device(endpoint: string, login: string): { muted: PushEvent[] } | null {
    const device = this.find(endpoint, login)
    return device ? { muted: [...device.muted] } : null
  }

  /** Add or refresh a device. A browser can renew its subscription; the endpoint names it. */
  async subscribe(login: string, subscription: PushSubscriptionJson, muted?: PushEvent[]): Promise<{ muted: PushEvent[] }> {
    if (new URL(subscription.endpoint).protocol !== 'https:') throw new Error('A push endpoint must use https')
    const existing = this.find(subscription.endpoint, login)
    const device: Device = {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      login,
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      muted: muted ?? existing?.muted ?? [],
    }
    this.file.devices = [...this.file.devices.filter(d => d.endpoint !== subscription.endpoint), device]
    await this.save()
    return { muted: [...device.muted] }
  }

  async setMuted(endpoint: string, login: string, muted: PushEvent[]): Promise<{ muted: PushEvent[] }> {
    const device = this.find(endpoint, login)
    if (!device) throw new Error('Notifications are not on for this device')
    device.muted = PUSH_EVENTS.filter(event => muted.includes(event))
    await this.save()
    return { muted: [...device.muted] }
  }

  async unsubscribe(endpoint: string, login: string): Promise<void> {
    if (!this.find(endpoint, login)) return
    this.file.devices = this.file.devices.filter(d => d.endpoint !== endpoint)
    await this.save()
  }

  /**
   * Send every device you turned notifications on a test now, whatever it muted, so you can see
   * that each one works. Says how many it reached and why any were refused.
   */
  async test(login: string): Promise<{ devices: number; sent: number; errors: string[] }> {
    const devices = this.file.devices.filter(d => d.login === login)
    if (!devices.length) throw new Error('No device has notifications on')
    const message: PushMessage = { title: 'Grip', body: 'Notifications work on this device.', url: '/', tag: 'grip-test' }
    const results = await Promise.all(devices.map(device => this.deliver(device, message)))
    const errors = results.flatMap(result => (result.ok ? [] : [result.error]))
    return { devices: devices.length, sent: devices.length - errors.length, errors }
  }

  /** Notify every device that has not muted this event. Failures are logged, never thrown. */
  async notify(event: PushEvent, message: PushMessage): Promise<void> {
    const devices = this.file.devices.filter(d => this.options.allowedLogins.includes(d.login) && !d.muted.includes(event))
    await Promise.all(devices.map(device => this.deliver(device, message)))
  }

  /** Notify when a run that was working finishes or fails. Stopping a run yourself says nothing. */
  watchRuns(store: EventEmitter<RunEvents> & { list(): Run[] }): void {
    const last = new Map<string, RunStatus>(store.list().map(run => [run.id, run.status]))
    store.on('change', run => {
      const before = last.get(run.id)
      last.set(run.id, run.status)
      if (before !== 'running' || (run.status !== 'done' && run.status !== 'failed')) return
      const done = run.status === 'done'
      void this.notify(done ? 'run-done' : 'run-failed', {
        title: run.title,
        body: `${ENGINE_NAMES[run.engine]} worker ${done ? 'finished' : 'failed'}`,
        url: `/#/runs/${encodeURIComponent(run.id)}`,
        tag: run.id,
      })
    })
  }

  /** Notify when a Claw update failed its checks and Grip went back to the last good version. */
  watchClaw(supervisor: { on(event: 'rolled-back', listener: (event: RolledBack) => void): unknown }): void {
    supervisor.on('rolled-back', event => {
      void this.notify('claw-rolled-back', {
        title: 'Claw update rolled back',
        body: `${event.attempted} failed its checks, so Grip is back on ${event.to}.`,
        url: '/',
        tag: 'claw-update',
      })
    })
  }

  /** Tell devices this machine is about to go offline, before the network goes. */
  offline(host: string, why: 'sleep' | 'shutdown' | 'logoff'): Promise<void> {
    const title = { sleep: `${host} is going to sleep`, shutdown: `${host} is shutting down`, logoff: `You signed out of ${host}` }[why]
    return this.notify('principal-offline', {
      title,
      body: 'Grip and its workers are offline until it is back.',
      url: '/',
      tag: 'principal-offline',
    })
  }

  private find(endpoint: string, login: string): Device | undefined {
    return this.file.devices.find(d => d.endpoint === endpoint && d.login === login)
  }

  private async deliver(device: Device, message: PushMessage) {
    // No Topic header: Apple refuses it (BadWebPushTopic). The notification's tag already
    // replaces an earlier one about the same run on the device.
    const result = await this.send(device, JSON.stringify(message), { ttlSeconds: this.options.expirySeconds ?? 24 * 60 * 60 })
    if (!result.ok && result.gone) {
      this.file.devices = this.file.devices.filter(d => d.endpoint !== device.endpoint)
      await this.save()
      this.options.log?.(`a device turned notifications off (${result.status}); removed it`)
    } else if (!result.ok) this.options.log?.(`push failed (${result.status || 'no answer'}): ${result.error}`)
    return result
  }

  private save(): Promise<void> {
    // The private key lives here, so only your user may read it.
    const data = `${JSON.stringify(this.file, null, 2)}\n`
    this.writes = this.writes.then(() => writeFileAtomic(this.options.path, data, 0o600))
    return this.writes
  }
}
