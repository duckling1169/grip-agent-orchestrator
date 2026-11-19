import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadConfig } from './config.js'
import { temporaryHome } from './testing/harness.js'

describe('loadConfig', () => {
  it("allows this machine's Tailscale owner when no login is listed, and saves it", async () => {
    const path = join(await temporaryHome(), 'config.json')
    expect(await loadConfig(path, async () => 'you@example.com')).toEqual({ allowedLogins: ['you@example.com'], quotaRefreshMinutes: 5 })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ allowedLogins: ['you@example.com'] })
  })

  it('keeps listed logins and settings, and refuses bad values', async () => {
    const path = join(await temporaryHome(), 'config.json')
    await writeFile(path, JSON.stringify({ allowedLogins: [' a@x.com '], quotaRefreshMinutes: 0 }))
    const owner = async () => 'owner@x.com'
    expect(await loadConfig(path, owner)).toEqual({ allowedLogins: ['a@x.com'], quotaRefreshMinutes: 0 })

    await writeFile(path, JSON.stringify({ allowedLogins: 'a@x.com' }))
    await expect(loadConfig(path, owner)).rejects.toThrow('allowedLogins must be a list')
  })

  it('allows nobody when Tailscale has no owner to offer', async () => {
    expect(await loadConfig(join(await temporaryHome(), 'config.json'), async () => null)).toMatchObject({ allowedLogins: [] })
  })

  it('rejects refresh intervals that could turn into a one millisecond paid-probe loop', async () => {
    const path = join(await temporaryHome(), 'config.json')
    for (const quotaRefreshMinutes of [0.000001, 1e20]) {
      await writeFile(path, JSON.stringify({ quotaRefreshMinutes }))
      await expect(loadConfig(path, async () => null)).rejects.toThrow('quotaRefreshMinutes')
    }
  })
})
