import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadConfig } from '../config.js'
import { crossSiteWrite, identify } from './identity.js'

describe('identify', () => {
  const allowed = ['duckling1169@github']

  it('lets in an allowed login, ignoring case', () => {
    expect(identify({ 'tailscale-user-login': 'Duckling1169@GitHub' }, allowed)).toEqual({ ok: true, login: 'Duckling1169@GitHub' })
  })

  it('refuses a missing header (a local process) and an unknown login', () => {
    expect(identify({}, allowed)).toMatchObject({ ok: false, status: 401 })
    expect(identify({ 'tailscale-user-login': '  ' }, allowed)).toMatchObject({ ok: false, status: 401 })
    expect(identify({ 'tailscale-user-login': 'someone@github' }, allowed)).toMatchObject({ ok: false, status: 403 })
    expect(identify({ 'tailscale-user-login': 'duckling1169@github' }, [])).toMatchObject({ ok: false, status: 403 })
  })
})

describe('crossSiteWrite', () => {
  const json = { 'content-type': 'application/json; charset=utf-8', host: 'windows-pc.tail.ts.net' }

  it('allows reads, and JSON writes from the same origin or none', () => {
    expect(crossSiteWrite('GET', {})).toBeNull()
    expect(crossSiteWrite('POST', json)).toBeNull()
    expect(crossSiteWrite('POST', { ...json, origin: 'https://windows-pc.tail.ts.net' })).toBeNull()
    expect(
      crossSiteWrite('POST', {
        ...json,
        host: '127.0.0.1:18798',
        'x-forwarded-host': 'windows-pc.tail.ts.net',
        origin: 'https://windows-pc.tail.ts.net',
      }),
    ).toBeNull()
  })

  it('refuses form posts, other origins and opaque origins', () => {
    expect(crossSiteWrite('POST', { 'content-type': 'text/plain', host: json.host })).toMatch(/application\/json/)
    expect(crossSiteWrite('DELETE', { host: json.host })).toMatch(/application\/json/)
    expect(crossSiteWrite('POST', { ...json, origin: 'https://evil.example' })).toMatch(/may not write/)
    expect(crossSiteWrite('POST', { ...json, origin: 'null' })).toMatch(/may not write/)
  })
})

describe('loadConfig', () => {
  const temp = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grip-config-'))
    return { path: join(dir, 'config.json'), done: () => rm(dir, { recursive: true, force: true }) }
  }

  it("trusts this machine's Tailscale owner on first run and writes it down", async () => {
    const t = await temp()
    try {
      const config = await loadConfig(t.path, { owner: async () => 'duckling1169@github' })
      expect(config).toEqual({ allowedLogins: ['duckling1169@github'], trustedOwner: 'duckling1169@github' })
      expect(JSON.parse(await readFile(t.path, 'utf8'))).toEqual({ allowedLogins: ['duckling1169@github'] })
      // Once written, the file wins and Tailscale is not asked again.
      const again = await loadConfig(t.path, { owner: async () => 'someone-else@github' })
      expect(again).toEqual({ allowedLogins: ['duckling1169@github'], trustedOwner: null })
    } finally {
      await t.done()
    }
  })

  it('writes an empty list when Tailscale has no owner, and asks again next start', async () => {
    const t = await temp()
    try {
      expect(await loadConfig(t.path, { owner: async () => null })).toEqual({ allowedLogins: [], trustedOwner: null })
      expect(JSON.parse(await readFile(t.path, 'utf8'))).toEqual({ allowedLogins: [] })
      expect((await loadConfig(t.path, { owner: async () => 'duckling1169@github' })).allowedLogins).toEqual(['duckling1169@github'])
    } finally {
      await t.done()
    }
  })

  it('keeps logins listed by hand and refuses a malformed list', async () => {
    const t = await temp()
    try {
      await writeFile(t.path, JSON.stringify({ allowedLogins: [' duckling1169@github ', ''] }))
      expect((await loadConfig(t.path)).allowedLogins).toEqual(['duckling1169@github'])
      await writeFile(t.path, JSON.stringify({ allowedLogins: 'duckling1169@github' }))
      await expect(loadConfig(t.path)).rejects.toThrow('allowedLogins must be a list')
    } finally {
      await t.done()
    }
  })
})
