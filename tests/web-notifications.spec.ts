import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { isMobile } from './viewport.js'

async function mockNotifications(page: Page, permission: 'default' | 'denied' = 'default', unsubscribeWorks = true) {
  await page.addInitScript(
    ({ initialPermission, keys, unsubscribeWorks }) => {
      let permission: NotificationPermission = initialPermission
      const probe = { prompts: 0, registrations: 0 }
      Object.defineProperty(window, 'notificationProbe', { value: probe })
      Object.defineProperty(window, 'Notification', {
        value: class {
          static get permission() {
            return permission
          }
          static async requestPermission() {
            probe.prompts++
            permission = 'granted'
            return permission
          }
        },
      })
      Object.defineProperty(window, 'PushManager', { value: class {} })
      let registered = false
      let subscription: PushSubscription | null = null
      const registration = {
        active: {},
        pushManager: {
          getSubscription: async () => subscription,
          subscribe: async ({ applicationServerKey }: { applicationServerKey: string }) => {
            const endpoint = `https://fcm.googleapis.com/fcm/send/preview-${crypto.randomUUID()}`
            subscription = {
              endpoint,
              options: {
                applicationServerKey: Uint8Array.from(atob(applicationServerKey.replace(/-/g, '+').replace(/_/g, '/')), char =>
                  char.charCodeAt(0),
                ).buffer,
              },
              toJSON: () => ({ endpoint, keys }),
              unsubscribe: async () => {
                if (!unsubscribeWorks) return false
                subscription = null
                return true
              },
            } as unknown as PushSubscription
            return subscription
          },
        },
      }
      Object.defineProperty(navigator, 'serviceWorker', {
        value: {
          getRegistration: async () => (registered ? registration : undefined),
          register: async () => {
            probe.registrations++
            registered = true
            return registration
          },
        },
      })
    },
    {
      initialPermission: permission,
      unsubscribeWorks,
      keys: {
        p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'),
        auth: Buffer.alloc(16, 2).toString('base64url'),
      },
    },
  )
}

test('notification settings enable, test and disable this device without prompting on load', async ({ page }) => {
  await mockNotifications(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const notifications = page.getByRole('region', { name: 'Notifications' })
  await expect(notifications.getByRole('button', { name: 'Enable notifications' })).toBeVisible()
  expect(
    await page.evaluate(() => (window as unknown as { notificationProbe: { prompts: number; registrations: number } }).notificationProbe),
  ).toEqual({ prompts: 0, registrations: 0 })
  await notifications.getByRole('button', { name: 'Enable notifications' }).click()
  await expect(notifications.getByText('Notifications are enabled on this device.')).toBeVisible()
  await notifications.getByRole('button', { name: 'Send notification test' }).click()
  await expect(notifications.getByRole('status')).toContainText(/Push service accepted \d+ of \d+ test notifications; 0 failed/)
  await expect(notifications.getByRole('status')).toContainText('Device delivery is not confirmed.')
  await notifications.getByRole('button', { name: 'Disable on this device' }).click()
  await expect(notifications.getByText('Notifications are off on this device.')).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { notificationProbe: { prompts: number } }).notificationProbe.prompts)).toBe(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await page.screenshot({ path: `test-results/notifications-${isMobile(page) ? 'mobile' : 'desktop'}.png` })
})

test('blocked notification permission explains recovery without prompting', async ({ page }) => {
  await mockNotifications(page, 'denied')
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const notifications = page.getByRole('region', { name: 'Notifications' })
  await expect(notifications.getByText(/Notifications are blocked/)).toBeVisible()
  await expect(notifications.getByRole('button', { name: 'Enable notifications' })).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { notificationProbe: { prompts: number } }).notificationProbe.prompts)).toBe(0)
})

test('a browser unsubscribe failure still shows that Moxy disabled this device', async ({ page }) => {
  await mockNotifications(page, 'default', false)
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const notifications = page.getByRole('region', { name: 'Notifications' })
  await notifications.getByRole('button', { name: 'Enable notifications' }).click()
  await notifications.getByRole('button', { name: 'Disable on this device' }).click()
  await expect(notifications.getByRole('alert')).toContainText('Moxy disabled this device')
  await expect(notifications.getByText('Notifications are off on this device.')).toBeVisible()
  await expect(notifications.getByRole('button', { name: 'Disable on this device' })).toHaveCount(0)
})

test('notification task links open the finished task in the inspector', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('moxy:inspector-open', 'false'))
  await page.goto('/?task=dark-mode')
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  await expect(inspector.getByText('How to try it', { exact: true })).toBeVisible()
  await expect(inspector.getByText('localhost:5173/settings', { exact: true })).toBeVisible()
  await expect(inspector.getByText('Done', { exact: true })).toBeVisible()
})
