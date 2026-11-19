import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const isMobile = (page: Page) => (page.viewportSize()?.width ?? 0) < 768

test('the machine switcher opens another Moxy without forwarding this machine credentials or task selection', async ({ page }) => {
  await page.goto('/?task=dark-mode')
  await page.getByRole('button', { name: /^Switch machine:/ }).click()
  await expect(page.getByRole('menuitem', { name: /Current/ })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /Sleeping workstation.*Tailnet offline/ })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: /Other workstation.*Moxy not detected/ })).toBeDisabled()
  const destination = 'https://laptop.preview-tail.ts.net/'
  const peer = page.getByRole('menuitem', { name: 'Open Moxy on Preview laptop' })
  await expect(peer).toHaveAttribute('href', destination)
  await page.route(`${destination}**`, route => {
    expect(route.request().headers()).not.toHaveProperty('authorization')
    expect(route.request().headers()).not.toHaveProperty('tailscale-user-login')
    return route.fulfill({ contentType: 'text/html', body: '<title>Other Moxy</title><p>Preview laptop Moxy</p>' })
  })
  await page.screenshot({ path: `test-results/machines-${isMobile(page) ? 'mobile' : 'desktop'}.png`, animations: 'disabled' })
  await peer.click()
  await expect(page).toHaveURL(destination)
  await expect(page.getByText('Preview laptop Moxy')).toBeVisible()
})

test('machine discovery errors keep cached destinations and allow another refresh', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /^Switch machine:/ }).click()
  await expect(page.getByRole('menuitem', { name: 'Open Moxy on Preview laptop' })).toBeVisible()
  await page.route('**/api/machines*', route =>
    route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Tailscale is unavailable' }) }),
  )
  await page.getByRole('menuitem', { name: 'Refresh machines' }).click()
  await expect(page.getByRole('alert')).toContainText('Tailscale is unavailable')
  await expect(page.getByRole('menuitem', { name: 'Open Moxy on Preview laptop' })).toBeVisible()
  await page.unroute('**/api/machines*')
  await page.route('**/api/machines*', route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        machines: [{ id: 'self', name: 'Preview desktop', dnsName: '', self: true, online: false, moxy: 'yes', url: null }],
        checkedAt: new Date().toISOString(),
        error: 'Tailscale stopped',
      }),
    }),
  )
  await page.getByRole('menuitem', { name: 'Refresh machines' }).click()
  await expect(page.getByRole('alert')).toContainText('Tailscale stopped')
  await expect(page.getByRole('menuitem', { name: 'Open Moxy on Preview laptop' })).toBeVisible()
  await page.unroute('**/api/machines*')
  await page.route('**/api/machines*', route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        machines: [
          { id: 'self', name: 'Preview desktop', dnsName: '', self: true, online: true, moxy: 'yes', url: null },
          {
            id: 'laptop',
            name: 'Preview laptop',
            dnsName: 'laptop.preview-tail.ts.net',
            self: false,
            online: false,
            moxy: 'unknown',
            url: null,
          },
        ],
        checkedAt: new Date().toISOString(),
        error: 'Machine discovery was limited',
      }),
    }),
  )
  await page.getByRole('menuitem', { name: 'Refresh machines' }).click()
  await expect(page.getByRole('alert')).toContainText('Machine discovery was limited')
  await expect(page.getByRole('menuitem', { name: 'Open Moxy on Preview laptop' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: /Preview laptop.*Tailnet offline/ })).toBeDisabled()
  await page.unroute('**/api/machines*')
  await page.getByRole('menuitem', { name: 'Refresh machines' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

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

test('notification task links open the task inspector without accepting the task', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('moxy:inspector-open', 'false'))
  await page.goto('/?task=dark-mode')
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  await expect(inspector.getByText('How to try it', { exact: true })).toBeVisible()
  await expect(inspector.getByText('localhost:5173/settings', { exact: true })).toBeVisible()
  const state = await (await page.request.get('/api/state')).json()
  expect(state.tasks.find((task: { id: string }) => task.id === 'dark-mode').status).toBe('waiting')
})

async function openIdle(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('status')).toHaveCount(0, { timeout: 20_000 })
}

async function send(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: 'Message Moxy' })
  await box.fill(text)
  await box.press('Enter')
  await expect(page.locator('.msg-user', { hasText: text })).toBeVisible()
}

test('a message gets a reply, and a later one queues behind it', async ({ page }) => {
  await openIdle(page)
  const first = `Plan the release ${Date.now()}`
  await send(page, first)
  await expect(page.getByRole('status')).toContainText('Moxy is working')
  await expect(page.getByRole('button', { name: 'Stop Moxy' })).toBeVisible()

  const second = `Also check the changelog ${Date.now()}`
  await send(page, second)
  await expect(page.getByText('Queued').last()).toBeVisible()
  await expect(page.locator('.msg-moxy', { hasText: second })).toBeVisible({ timeout: 15_000 })
})

test('Stop ends the running turn', async ({ page }) => {
  await openIdle(page)
  await send(page, `Start something slow ${Date.now()}`)
  await page.getByRole('button', { name: 'Stop Moxy' }).click()
  await expect(page.getByRole('status')).toHaveCount(0)
  await expect(page.locator('.note-line', { hasText: 'Stopped' }).last()).toBeVisible()
})

test('a failed turn can be retried from its message', async ({ page }) => {
  await openIdle(page)
  const text = `Please fail ${Date.now()}`
  await send(page, text)
  const line = page.locator('.user-line', { hasText: text })
  await expect(line.getByRole('button', { name: 'Failed. Retry' })).toBeVisible({ timeout: 15_000 })
  await line.getByRole('button', { name: 'Failed. Retry' }).click()
  await expect(page.getByRole('status')).toContainText('Moxy is working')
})

test('a task opens in the inspector and leads to its workers', async ({ page }) => {
  await page.goto('/')
  if (isMobile(page)) {
    await expect(page.getByRole('button', { name: /^Tasks/ })).toContainText('1')
    await page.getByRole('button', { name: /^Tasks/ }).click()
  }
  await page
    .getByRole('button', { name: /Departures board pagination/ })
    .first()
    .click()
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  await expect(inspector.getByText('20 rows a page')).toBeVisible()
  await inspector.getByRole('button', { name: /Pagination URL state/ }).click()
  await expect(inspector.getByText('is not assignable to type')).toBeVisible()
  await inspector.getByRole('tab', { name: 'Changes' }).click()
  await expect(inspector.getByText('no diff')).toBeVisible()
  if (isMobile(page)) {
    await inspector.getByRole('button', { name: 'Back' }).click()
    await expect(inspector.getByText('20 rows a page')).toBeVisible()
  }
})

test('the theme setting switches to light', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('radio', { name: 'Light' }).click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await page.getByRole('radio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
})

test('the layout never scrolls sideways', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('textbox', { name: 'Message Moxy' })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBe(0)
})

test('the ACP catalog supplies next-turn models and effort choices', async ({ page }) => {
  await openIdle(page)
  await page.getByRole('button', { name: /^Next-turn model:/ }).click()
  await page.getByRole('menuitemradio', { name: 'Claude Sonnet preview' }).click()
  await expect(page.getByRole('button', { name: 'Next-turn model: Claude Sonnet preview' })).toBeVisible()
  await page.getByRole('button', { name: /^Next-turn effort:/ }).click()
  await page.getByRole('menuitemradio', { name: 'high', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Next-turn effort: high' })).toBeVisible()
})

test('flat quota rows show remaining windows and provider rechecks without expansion', async ({ page }) => {
  await page.goto('/')
  if (isMobile(page)) await page.getByRole('button', { name: 'Quota', exact: true }).click()
  else {
    const resize = page.getByRole('separator', { name: 'Resize tasks' })
    await resize.focus()
    for (let step = 0; step < 4; step++) await resize.press('ArrowLeft')
  }
  const quota = page.getByRole('region', { name: 'Provider quota' }).filter({ visible: true })
  const claude = quota.getByRole('row', { name: 'Claude quota', exact: true })
  await expect(claude).toBeVisible()
  await expect(quota.locator('details, summary')).toHaveCount(0)
  const fiveHour = claude.getByLabel('5h quota remaining')
  await expect(fiveHour).toContainText(/(?:65|58)%/)
  for (const label of ['Family', 'Last checked', '5h left', '7d left']) {
    await expect(quota.getByRole('columnheader', { name: label, exact: true })).toHaveCount(1)
  }
  await expect(claude.getByText('5h left')).toHaveCount(0)
  await expect(claude.getByLabel('7d quota remaining')).toContainText('28%')
  await expect(fiveHour).toHaveAttribute('title', /Resets.*Observed/)
  const gemini = quota.getByRole('row', { name: 'Gemini quota', exact: true })
  await expect(gemini.getByLabel('5h quota remaining')).toContainText('—')
  await expect(gemini.getByLabel('7d quota remaining')).toContainText('—')
  await expect(gemini).not.toContainText('temporarily unavailable')
  const unavailableFamily = gemini.getByText('Gemini', { exact: true }).filter({ visible: true })
  await expect(unavailableFamily).toHaveAttribute('title', 'Gemini quota temporarily unavailable')
  const unavailableColor = await unavailableFamily.evaluate(element => getComputedStyle(element).color)
  const availableColor = await claude
    .getByText('Claude', { exact: true })
    .filter({ visible: true })
    .evaluate(element => getComputedStyle(element).color)
  expect(unavailableColor).not.toEqual(availableColor)
  await expect(quota.getByText(/one small Haiku turn/)).toBeVisible()
  await expect(claude).not.toContainText(/Stale|\*/)
  const family = await claude.getByText('Claude', { exact: true }).filter({ visible: true }).boundingBox()
  const checked = await claude.locator('time').boundingBox()
  const usage = await fiveHour.boundingBox()
  expect(family).not.toBeNull()
  expect(checked).not.toBeNull()
  expect(usage).not.toBeNull()
  expect(checked!.x).toBeGreaterThan(family!.x)
  expect(checked!.x + checked!.width).toBeLessThanOrEqual(usage!.x)
  await claude.getByRole('button', { name: 'Recheck Claude quota' }).click()
  await expect(fiveHour).toContainText('58%')
  await expect(claude.getByLabel('7d quota remaining')).toContainText('28%')
  expect(await quota.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0)
  await page.screenshot({ path: `test-results/flat-quota-${isMobile(page) ? 'mobile' : 'desktop'}.png` })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('spinbutton', { name: 'Quota refresh minutes' }).fill('0')
  await page.getByRole('button', { name: 'Save quota timer' }).click()
  await expect(page.getByText('Automatic refresh is off.')).toBeVisible()
})
