import { hostname } from 'node:os'

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const isMobile = (page: Page) => (page.viewportSize()?.width ?? 0) < 768

test('shows the host as text in the header', async ({ page }) => {
  await page.goto('/')
  const header = page.getByRole('banner')
  const host = hostname()
  await expect(header.getByText(host, { exact: true })).toBeVisible()
  await expect(header.getByRole('button').filter({ hasText: host })).toHaveCount(0)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('region', { name: 'Settings' })
  await expect(settings.getByText('Signed in as')).toBeVisible()
  await expect(settings.getByText('Machine', { exact: true })).toHaveCount(0)
})

test('files can be picked, removed, and sent as an attachment-only message', async ({ page }) => {
  await openIdle(page)
  const composer = page.getByTestId('message-box')
  await expect(composer.getByPlaceholder("What's up?")).toBeVisible()
  const add = composer.getByRole('button', { name: 'Attach files' })
  const pick = async (file: { name: string; mimeType: string; buffer: Buffer }) => {
    const chooser = page.waitForEvent('filechooser')
    await add.click()
    await (await chooser).setFiles(file)
  }
  await pick({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('test') })
  await expect(composer.getByText('notes.txt')).toBeVisible()
  await expect(composer.getByText('4 B')).toBeVisible()
  await composer.getByRole('button', { name: 'Remove notes.txt' }).click()
  await expect(composer.getByText('notes.txt')).toHaveCount(0)
  const dropped = await page.evaluateHandle(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['drop'], 'dropped.txt', { type: 'text/plain' }))
    return transfer
  })
  await composer.dispatchEvent('drop', { dataTransfer: dropped })
  await expect(composer.getByText('dropped.txt')).toBeVisible()
  await composer.getByRole('button', { name: 'Remove dropped.txt' }).click()
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB9sAAAAASUVORK5CYII='
  await composer.getByRole('textbox').evaluate((textarea, png) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([Uint8Array.from(atob(png), char => char.charCodeAt(0))], 'pasted.png', { type: 'image/png' }))
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, png)
  await expect(composer.getByRole('img', { name: 'pasted.png' })).toBeVisible()
  await composer.getByRole('button', { name: 'Remove pasted.png' }).click()
  const name = `attachment-${Date.now()}.png`
  await pick({
    name,
    mimeType: 'image/png',
    buffer: Buffer.from(png, 'base64'),
  })
  await expect(composer.getByRole('img', { name })).toBeVisible()
  await composer.getByRole('button', { name: 'Send', exact: true }).click()
  const thumbnail = page.getByTestId('user-message').getByRole('img', { name })
  await expect(thumbnail).toBeVisible()
  await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1)
  const full = page.waitForEvent('popup')
  await thumbnail.click()
  await expect(await full).toHaveURL(/\/api\/uploads\//)
  await expect(activeTurn(page)).toHaveCount(0, { timeout: 15000 })
})

test('engine changes apply to the next turn and can switch and retry a quota failure', async ({ page }) => {
  await openIdle(page)
  await page.getByRole('button', { name: /^Orchestrator:/ }).click()
  const codex = page.getByRole('menuitemradio', { name: 'Codex', exact: true })
  await expect(codex).toBeEnabled()
  await codex.click()
  await expect(page.getByRole('button', { name: 'Orchestrator: Codex' })).toBeVisible()
  await page.getByRole('button', { name: /^Orchestrator:/ }).click()
  await page.getByRole('menuitemradio', { name: 'Claude', exact: true }).click()
  await send(page, `Please fail for recovery ${Date.now()}`)
  await expect(page.getByRole('button', { name: /Switch to Codex and retry/ })).toBeVisible({ timeout: 15000 })
  await page.getByRole('button', { name: /Switch to Codex and retry/ }).click()
  await expect(page.getByRole('button', { name: 'Orchestrator: Codex' })).toBeVisible()
  await expect(page.getByTestId('moxy-message').filter({ hasText: 'This is the local preview' }).last()).toBeVisible({ timeout: 15000 })
  await expect(activeTurn(page)).toHaveCount(0, { timeout: 15000 })
  await page.screenshot({ path: `test-results/recovery-${isMobile(page) ? 'mobile' : 'desktop'}.png`, animations: 'disabled' })
  await page.getByRole('button', { name: /^Orchestrator:/ }).click()
  await page.getByRole('menuitemradio', { name: 'Claude', exact: true }).click()
})

test('an interrupted worker keeps its status tint on hover and selection', async ({ page }) => {
  test.skip(isMobile(page), 'Selection opens a separate page on mobile')
  await page.goto('/')
  const worker = page.getByRole('button', { name: 'Profile cold start' })
  const background = () => worker.evaluate(element => getComputedStyle(element).backgroundColor)
  const resting = await background()
  await worker.hover()
  expect.soft(await background()).toBe(resting)
  await worker.click()
  await expect(worker).toHaveAttribute('aria-current', 'true')
  await page.getByRole('button', { name: 'Close inspector' }).hover()
  expect(await background()).toBe(resting)
})

test('tasks sit under Working while a worker runs, Reviewing while Moxy checks them, then Done', async ({ page }) => {
  await openIdle(page)
  if (isMobile(page)) await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  const sections = page.getByRole('navigation', { name: 'Tasks' })
  const section = (label: string) =>
    sections.locator(':scope > div').filter({ has: page.getByRole('button', { name: new RegExp(`^${label}\\s*\\d+$`) }) })
  await expect(section('Working').getByRole('button', { name: 'Departures board pagination' })).toBeVisible()
  await expect(section('Reviewing').getByRole('button', { name: 'Upgrade Vite to 8' })).toBeVisible()
  await expect(section('Done').getByRole('button', { name: 'Dark mode toggle in settings' })).toBeVisible()
  await expect(section('Standalone workers').getByRole('button', { name: 'Profile cold start' })).toBeVisible()
  await expect(page.getByText('Waiting on you')).toHaveCount(0)
  await page.screenshot({ path: `test-results/task-stages-${isMobile(page) ? 'mobile' : 'desktop'}.png` })
})

async function openIdle(page: Page) {
  await page.goto('/')
  await expect(activeTurn(page)).toHaveCount(0, { timeout: 20_000 })
}

function activeTurn(page: Page) {
  return page.getByRole('status').filter({ has: page.getByText(/^Moxy is working · /) })
}

async function send(page: Page, text: string) {
  const box = page.getByRole('textbox', { name: 'Message Moxy' })
  await box.fill(text)
  await box.press('Enter')
  await expect(page.getByTestId('user-message').filter({ hasText: text })).toBeVisible()
}

test('a tap anywhere in the message box starts typing, and the send button sends', async ({ page }) => {
  await openIdle(page)
  const text = `Tapped message ${Date.now()}`
  await page.getByTestId('message-box').click({ position: { x: 4, y: 4 } })
  await expect(page.getByRole('textbox', { name: 'Message Moxy' })).toBeFocused()
  await page.keyboard.type(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByTestId('user-message').filter({ hasText: text })).toBeVisible()
  await expect(page.getByTestId('moxy-message').filter({ hasText: 'This is the local preview' }).last()).toBeVisible({ timeout: 15_000 })
})

test('a message gets a reply, and a later one queues behind it', async ({ page }) => {
  await openIdle(page)
  const first = `Plan the release ${Date.now()}`
  await send(page, first)
  await expect(activeTurn(page)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop Moxy' })).toBeVisible()

  const second = `Also check the changelog ${Date.now()}`
  await send(page, second)
  await expect(page.getByText('Queued').last()).toBeVisible()
  await expect(page.getByTestId('moxy-message').filter({ hasText: second })).toBeVisible({ timeout: 15_000 })
})

test('Stop ends the running turn', async ({ page }) => {
  await openIdle(page)
  await send(page, `Start something slow ${Date.now()}`)
  await expect(activeTurn(page)).toBeVisible()
  await page.getByRole('button', { name: 'Stop Moxy' }).click()
  await expect(activeTurn(page)).toHaveCount(0)
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /^Stopped$/ })
      .last(),
  ).toBeVisible()
})

test('a failed turn can be retried from its message', async ({ page }) => {
  await openIdle(page)
  const text = `Please fail ${Date.now()}`
  await send(page, text)
  const line = page.getByTestId('failed-message').filter({ hasText: text })
  await expect(line.getByRole('button', { name: 'Failed. Retry' })).toBeVisible({ timeout: 15_000 })
  await expect(line.getByTestId('user-message')).toHaveCSS('max-width', 'none')
  await line.getByRole('button', { name: 'Failed. Retry' }).click()
  await expect(activeTurn(page)).toBeVisible()
})

test('the running worker ring is static and muted offline or with reduced motion', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto('/')
  if (isMobile(page)) await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  const task = page.getByRole('button', { name: /Departures board pagination/ }).first()
  const icon = task.getByRole('img', { name: 'Mixed models', exact: true })
  const ring = () =>
    icon.evaluate(element => {
      const style = getComputedStyle(element.parentElement!, '::after')
      return {
        animation: style.animationName,
        colors: [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor],
        opacity: style.opacity,
      }
    })
  const muted = 'rgb(229, 229, 229)'
  const offline = { animation: 'none', colors: [muted, muted, muted, muted], opacity: '1' }
  expect.soft(await ring()).toEqual({ ...offline, colors: ['rgb(82, 82, 82)', muted, muted, muted] })
  await page.locator('#app > div').evaluate(element => element.setAttribute('data-offline', 'true'))
  expect.soft(await ring()).toEqual(offline)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  expect(await ring()).toEqual(offline)
})

test('a task opens in the inspector and leads to its workers', async ({ page }) => {
  await page.goto('/')
  if (isMobile(page)) await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await page
    .getByRole('button', { name: /Departures board pagination/ })
    .first()
    .click()
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  await expect(inspector.getByText('20 rows a page')).toBeVisible()
  const running = inspector.getByRole('button', { name: /Departures board pagination Working/ })
  await expect(running.getByText('Claude · opus · high')).toBeVisible()
  await expect(running.getByText(/^Started .* · running \d+ (s|min)$/)).toBeVisible()
  await expect(running.getByText('Run the pager tests')).toBeVisible()
  await inspector.getByRole('button', { name: /Pagination URL state/ }).click()
  await expect(inspector.getByText('is not assignable to type')).toBeVisible()
  await inspector.getByRole('tab', { name: 'Changes' }).click()
  await expect(inspector.getByText('no diff')).toBeVisible()
  if (isMobile(page)) {
    await inspector.getByRole('button', { name: 'Back' }).click()
    await expect(inspector.getByText('20 rows a page')).toBeVisible()
  }
})

test('icons follow the model family, and a task with mixed families shows a neutral icon', async ({ page }) => {
  await page.goto('/')
  if (isMobile(page)) await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  const tasks = page.getByRole('navigation', { name: 'Tasks' })
  const darkMode = tasks.getByRole('button', { name: 'Dark mode toggle in settings' })
  await expect(darkMode.getByRole('img', { name: 'GPT', exact: true }).first()).toBeVisible()
  const vite = tasks.getByRole('button', { name: 'Upgrade Vite to 8' })
  await expect(vite.getByRole('img', { name: 'Mixed models', exact: true })).toBeVisible()
  await vite.click()
  const inspector = page.getByRole('complementary', { name: 'Inspector' })
  const review = inspector.getByRole('button', { name: /Review the Vite upgrade/ })
  await expect(review.getByText('Antigravity · claude-sonnet-5-5 · high')).toBeVisible()
  await expect(review.getByRole('img', { name: 'Claude', exact: true }).first()).toBeVisible()
})
