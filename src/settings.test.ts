import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { Settings } from './settings.js'
import { temporaryHome } from './testing/harness.js'

it('persists quota timing without replacing identity or other config, then publishes the change', async () => {
  const path = join(await temporaryHome(), 'config.json')
  await writeFile(path, JSON.stringify({ allowedLogins: ['you@example.com'], extra: true }))
  const settings = new Settings(path, { quotaRefreshMinutes: 5 })
  const changes: unknown[] = []
  settings.on('change', value => changes.push(value))
  expect(await settings.update({ quotaRefreshMinutes: 0 })).toEqual({ quotaRefreshMinutes: 0 })
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ allowedLogins: ['you@example.com'], extra: true, quotaRefreshMinutes: 0 })
  expect(changes).toEqual([{ quotaRefreshMinutes: 0 }])
  await expect(settings.update({ quotaRefreshMinutes: -1 })).rejects.toThrow('quotaRefreshMinutes')
  await expect(settings.update({ quotaRefreshMinutes: 0.000001 })).rejects.toThrow('quotaRefreshMinutes')
  await expect(settings.update({ quotaRefreshMinutes: 1e20 })).rejects.toThrow('quotaRefreshMinutes')
  expect(settings.current()).toEqual({ quotaRefreshMinutes: 0 })
})
