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
  it('writes an empty config on first run and reads logins after', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grip-config-'))
    try {
      const path = join(dir, 'config.json')
      expect(await loadConfig(path)).toEqual({ allowedLogins: [] })
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ allowedLogins: [] })
      await writeFile(path, JSON.stringify({ allowedLogins: [' duckling1169@github ', ''] }))
      expect(await loadConfig(path)).toEqual({ allowedLogins: ['duckling1169@github'] })
      await writeFile(path, JSON.stringify({ allowedLogins: 'duckling1169@github' }))
      await expect(loadConfig(path)).rejects.toThrow('allowedLogins must be a list')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
