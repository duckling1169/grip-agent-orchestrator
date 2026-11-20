import type { Page } from '@playwright/test'

export const isMobile = (page: Page) => (page.viewportSize()?.width ?? 0) < 768

export async function showTasks(page: Page) {
  if (isMobile(page)) await page.getByRole('button', { name: 'Tasks', exact: true }).click()
}
