// Browser subscription handling adapted from Grip's web/src/components/notifications.tsx.

import type { PushReport, PushStatus, PushSubscriptionJson } from '../../../src/contracts/push.js'

export type NotificationApi = {
  pushInfo: (endpoint?: string) => Promise<PushStatus>
  pushSubscribe: (subscription: PushSubscriptionJson) => Promise<PushStatus>
  pushUnsubscribe: (endpoint: string) => Promise<PushStatus>
}

export type NotificationBrowser = {
  secure: boolean
  supported: boolean
  appleMobile: boolean
  standalone: boolean
  permission: () => NotificationPermission
  requestPermission: () => Promise<NotificationPermission>
  getRegistration: () => Promise<ServiceWorkerRegistration | undefined>
  register: () => Promise<ServiceWorkerRegistration>
}

export type NotificationState =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'blocked' }
  | { kind: 'on' | 'off' | 'renew'; publicKey: string; devices: number; endpoint: string | null }

export function notificationBrowser(): NotificationBrowser {
  return {
    secure: window.isSecureContext,
    supported: 'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator,
    appleMobile: /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
    standalone: window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true,
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    getRegistration: () => navigator.serviceWorker.getRegistration('/'),
    register: async () => {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
      if (registration.active) return registration
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          navigator.serviceWorker.ready,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Notification setup timed out. Try again.')), 15_000)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
  }
}

export function notificationProblem(browser: NotificationBrowser): string | null {
  if (!browser.secure) return 'Open Moxy through its HTTPS tailnet address to receive notifications.'
  if (browser.appleMobile && !browser.standalone)
    return 'On iPhone and iPad, use Share → Add to Home Screen, then open Moxy from your Home Screen.'
  return browser.supported ? null : 'This browser cannot receive push notifications.'
}

export function sameNotificationKey(subscription: PushSubscription, publicKey: string): boolean {
  const key = subscription.options.applicationServerKey
  if (!key) return false
  try {
    const wanted = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))
    const actual = new Uint8Array(key)
    return actual.length === wanted.length && actual.every((byte, index) => byte === wanted[index])
  } catch {
    return false
  }
}

export async function readNotificationState(api: NotificationApi, browser = notificationBrowser()): Promise<NotificationState> {
  const reason = notificationProblem(browser)
  if (reason) return { kind: 'unsupported', reason }
  if (browser.permission() === 'denied') return { kind: 'blocked' }
  const subscription = await (await browser.getRegistration())?.pushManager.getSubscription()
  const info = await api.pushInfo(subscription?.endpoint)
  const sameKey = subscription ? sameNotificationKey(subscription, info.publicKey) : false
  return {
    kind: subscription && !sameKey ? 'renew' : subscription && info.subscribed && browser.permission() === 'granted' ? 'on' : 'off',
    publicKey: info.publicKey,
    devices: info.devices,
    endpoint: subscription?.endpoint ?? null,
  }
}

export async function enableNotifications(api: NotificationApi, browser = notificationBrowser()): Promise<NotificationState> {
  const reason = notificationProblem(browser)
  if (reason) throw new Error(reason)
  const permission = await browser.requestPermission()
  if (permission === 'denied') return { kind: 'blocked' }
  if (permission !== 'granted') throw new Error('Notification permission was not granted. You can try again when ready.')
  const registration = await browser.register()
  let subscription = await registration.pushManager.getSubscription()
  const info = await api.pushInfo(subscription?.endpoint)
  if (subscription && !sameNotificationKey(subscription, info.publicKey)) {
    await api.pushUnsubscribe(subscription.endpoint)
    if (!(await subscription.unsubscribe())) throw new Error('This browser could not renew its notification subscription. Try again.')
    subscription = null
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: info.publicKey })
  const json = subscription.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth)
    throw new Error('This browser returned an incomplete notification subscription.')
  const saved = await api.pushSubscribe({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } })
  return { kind: saved.subscribed ? 'on' : 'off', ...saved, endpoint: subscription.endpoint }
}

export async function disableNotifications(api: NotificationApi, browser = notificationBrowser()): Promise<NotificationState> {
  const subscription = await (await browser.getRegistration())?.pushManager.getSubscription()
  const info = subscription ? await api.pushUnsubscribe(subscription.endpoint) : await api.pushInfo()
  if (subscription && !(await subscription.unsubscribe()))
    throw new Error('Moxy disabled this device, but the browser could not remove its subscription. Refresh its status.')
  return { kind: 'off', publicKey: info.publicKey, devices: info.devices, endpoint: null }
}

export function notificationTestMessage(report: PushReport): string {
  if (report.attempted === 0) return 'No registered devices to test.'
  return `Push service accepted ${report.sent} of ${report.attempted} test notifications; ${report.failed} failed. Device delivery is not confirmed.`
}
