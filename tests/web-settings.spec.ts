import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const isMobile = (page: Page) => (page.viewportSize()?.width ?? 0) < 768

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
  await page.goto('/')
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
  const checkedHeading = quota.getByRole('columnheader', { name: 'Last checked', exact: true })
  expect(
    await checkedHeading.evaluate(heading => {
      const text = document.createRange()
      text.selectNodeContents(heading)
      return text.getClientRects().length
    }),
  ).toBe(1)
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
