import { describe, expect, it } from 'vitest'

import {
  disableNotifications,
  enableNotifications,
  notificationProblem,
  notificationTestMessage,
  readNotificationState,
} from '../../web/src/lib/notifications.js'
import type { NotificationApi, NotificationBrowser } from '../../web/src/lib/notifications.js'

function setup() {
  const log: string[] = []
  const subscription = {
    endpoint: 'https://push.example/device',
    options: { applicationServerKey: Uint8Array.from([1, 2, 3]).buffer },
    unsubscribe: async () => {
      log.push('browser-unsubscribe')
      current = null
      return true
    },
    toJSON: () => ({ endpoint: 'https://push.example/device', keys: { auth: 'auth', p256dh: 'key' } }),
  } as unknown as PushSubscription
  let current: PushSubscription | null = subscription
  const registration = {
    active: {},
    pushManager: {
      getSubscription: async () => current,
      subscribe: async () => {
        log.push('browser-subscribe')
        current = subscription
        return subscription
      },
    },
  } as unknown as ServiceWorkerRegistration
  const browser: NotificationBrowser = {
    secure: true,
    supported: true,
    appleMobile: false,
    standalone: false,
    permission: () => 'granted',
    requestPermission: async () => {
      log.push('permission')
      return 'granted'
    },
    getRegistration: async () => registration,
    register: async () => {
      log.push('register')
      return registration
    },
  }
  const info = { publicKey: 'AQID', devices: 2, subscribed: true }
  const api: NotificationApi = {
    pushInfo: async endpoint => {
      log.push(endpoint ? 'info-device' : 'info')
      return { ...info }
    },
    pushSubscribe: async () => {
      log.push('server-subscribe')
      return { ...info }
    },
    pushUnsubscribe: async () => {
      log.push('server-unsubscribe')
      return { ...info, devices: 1, subscribed: false }
    },
  }
  return { log, browser, info, api, subscription }
}

describe('browser notifications', () => {
  it('reads both browser and server subscription state without registering or asking permission', async () => {
    const { api, browser, log, info } = setup()
    expect((await readNotificationState(api, browser)).kind).toBe('on')
    expect(log).toEqual(['info-device'])
    info.subscribed = false
    expect((await readNotificationState(api, browser)).kind).toBe('off')
    info.publicKey = 'BAUG'
    expect((await readNotificationState(api, browser)).kind).toBe('renew')
  })

  it('asks permission first on enable and replaces subscriptions for renewed server keys', async () => {
    const { api, browser, log, info } = setup()
    info.publicKey = 'BAUG'
    expect((await enableNotifications(api, browser)).kind).toBe('on')
    expect(log).toEqual([
      'permission',
      'register',
      'info-device',
      'server-unsubscribe',
      'browser-unsubscribe',
      'browser-subscribe',
      'server-subscribe',
    ])
  })

  it('removes this browser from Moxy before disabling its browser subscription', async () => {
    const { api, browser, log } = setup()
    expect(await disableNotifications(api, browser)).toMatchObject({ kind: 'off', devices: 1, endpoint: null })
    expect(log).toEqual(['server-unsubscribe', 'browser-unsubscribe'])
  })

  it('handles blocked, insecure and iOS Home Screen states without contacting the server', async () => {
    const { api, browser, log } = setup()
    browser.permission = () => 'denied'
    expect(await readNotificationState(api, browser)).toEqual({ kind: 'blocked' })
    browser.secure = false
    expect(notificationProblem(browser)).toMatch(/HTTPS/)
    browser.secure = true
    browser.appleMobile = true
    expect(notificationProblem(browser)).toMatch(/Home Screen/)
    expect(log).toEqual([])
  })

  it('never reports push service acceptance as device delivery', () => {
    expect(notificationTestMessage({ attempted: 3, sent: 2, failed: 1, errors: ['refused'] })).toBe(
      'Push service accepted 2 of 3 test notifications; 1 failed. Device delivery is not confirmed.',
    )
    expect(notificationTestMessage({ attempted: 0, sent: 0, failed: 0, errors: [] })).toBe('No registered devices to test.')
  })

  it('does not subscribe after permission refusal or a failed server removal', async () => {
    const { api, browser, log, info } = setup()
    browser.requestPermission = async () => 'denied'
    expect(await enableNotifications(api, browser)).toEqual({ kind: 'blocked' })
    expect(log).toEqual([])
    browser.requestPermission = async () => 'granted'
    info.publicKey = 'BAUG'
    api.pushUnsubscribe = async () => {
      throw new Error('Server unavailable')
    }
    await expect(enableNotifications(api, browser)).rejects.toThrow('Server unavailable')
    expect(log).toEqual(['register', 'info-device'])
  })

  it('reports failure when the browser refuses removal and does not create a second subscription', async () => {
    const { api, browser, log, info, subscription } = setup()
    info.publicKey = 'BAUG'
    subscription.unsubscribe = async () => false
    await expect(enableNotifications(api, browser)).rejects.toThrow('could not renew')
    expect(log).not.toContain('browser-subscribe')
    expect(log).not.toContain('server-subscribe')
  })
})
