import { mkdir, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'

import { chromium, devices, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

const url = process.env.MOXY_PREVIEW_URL ?? 'http://localhost:18799'
const browser = await chromium.launch()
await mkdir('docs/images', { recursive: true })

async function sanitize(page: Page) {
  await page.evaluate(host => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      node.textContent = (node.textContent ?? '')
        .replaceAll(host, 'your-pc')
        .replace(/[A-Za-z]:\\[^\s`]+moxy-web-preview-[^\\\s`]+/gi, 'C:\\Code\\preview')
    }
  }, hostname())
}

const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
await desktop.goto(url)
await desktop.getByRole('button', { name: 'Dark mode toggle in settings' }).click()
await expect(desktop.getByRole('complementary', { name: 'Inspector' }).getByText('How to try it')).toBeVisible()
await sanitize(desktop)
await desktop.screenshot({ path: 'docs/images/desktop.png', animations: 'disabled' })

const mobile = await browser.newPage({ ...devices['Pixel 7'], deviceScaleFactor: 1 })
await mobile.goto(url)
await expect(mobile.getByTestId('user-message').first()).toBeVisible()
await sanitize(mobile)
const conversation = await mobile.screenshot({ animations: 'disabled' })
await mobile.getByRole('button', { name: 'Tasks', exact: true }).click()
await sanitize(mobile)
const tasks = await mobile.screenshot({ animations: 'disabled' })
await mobile.getByRole('button', { name: 'Dark mode toggle in settings' }).click()
await expect(mobile.getByRole('complementary', { name: 'Inspector' }).getByText('How to try it')).toBeVisible()
await sanitize(mobile)
const inspector = await mobile.screenshot({ animations: 'disabled' })
const composite = await mobile.evaluate(
  async images => {
    const loaded = await Promise.all(
      images.map(
        source =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image()
            img.onload = () => resolve(img)
            img.onerror = reject
            img.src = `data:image/png;base64,${source}`
          }),
      ),
    )
    const canvas = document.createElement('canvas')
    canvas.width = loaded[0]!.width * loaded.length
    canvas.height = loaded[0]!.height
    const context = canvas.getContext('2d')!
    loaded.forEach((img, index) => context.drawImage(img, index * img.width, 0))
    return canvas.toDataURL('image/png').split(',')[1]!
  },
  [conversation, tasks, inspector].map(buffer => buffer.toString('base64')),
)
await writeFile('docs/images/mobile.png', Buffer.from(composite, 'base64'))
await browser.close()
