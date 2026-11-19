import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const isMobile = (page: Page) => (page.viewportSize()?.width ?? 0) < 768

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
