import { generateVAPIDKeys, sendNotification, WebPushError } from 'web-push'
import type { RequestOptions } from 'web-push'

/**
 * Standard Web Push through the `web-push` library, straight to the browser's push service
 * (Apple, Google or Mozilla). It encrypts each payload for the device and signs the request with
 * Grip's own VAPID key. No account, nothing to host.
 */

/** A device's subscription, as `PushSubscription.toJSON()` gives it. */
export type PushSubscriptionJson = { endpoint: string; keys: { p256dh: string; auth: string } }

/** Grip's VAPID key pair, URL-safe base64, as `web-push` makes them. */
export type VapidKeys = { publicKey: string; privateKey: string }

/** Push services ask for a contact; this points at the project rather than at anyone's address. */
export const VAPID_SUBJECT = 'https://github.com/duckling1169/grip-agent-orchestrator'

export const createVapidKeys = (): VapidKeys => generateVAPIDKeys()

export type PushResult = { ok: true } | { ok: false; status: number; gone: boolean; error: string }
export type PushSender = (subscription: PushSubscriptionJson, payload: string, options: { ttlSeconds: number }) => Promise<PushResult>

/** The library's options for one message. */
export function pushOptions(keys: VapidKeys, options: { ttlSeconds: number }, timeoutMs = 15_000): RequestOptions {
  return {
    vapidDetails: { subject: VAPID_SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
    TTL: options.ttlSeconds,
    urgency: 'normal',
    timeout: timeoutMs,
  }
}

/** Send one message. A 404 or 410 means the device unsubscribed, so its subscription can go. */
export function webPushSender(keys: VapidKeys, send: typeof sendNotification = sendNotification): PushSender {
  return async (subscription, payload, options) => {
    try {
      await send(subscription, payload, pushOptions(keys, options))
      return { ok: true }
    } catch (error) {
      if (error instanceof WebPushError) {
        const gone = error.statusCode === 404 || error.statusCode === 410
        return { ok: false, status: error.statusCode, gone, error: (error.body || error.message).slice(0, 200) }
      }
      return { ok: false, status: 0, gone: false, error: (error as Error).message }
    }
  }
}
