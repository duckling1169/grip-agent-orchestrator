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
