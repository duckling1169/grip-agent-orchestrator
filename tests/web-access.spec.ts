import { expect, test } from '@playwright/test'

for (const [status, error] of [
  [401, 'No Tailscale identity. Open Moxy through its Tailscale Serve address.'],
  [403, "guest@example.com is not allowed. Add it to allowedLogins in Moxy's config.json."],
] as const) {
  test(`shows the server's explanation when access is denied with HTTP ${status}`, async ({ page }) => {
    await page.route(/\/api\/(events|state)$/, route => route.fulfill({ status, json: { error } }))
    await page.goto('/')
    await expect(page.getByRole('alert')).toHaveText(error)
  })
}
