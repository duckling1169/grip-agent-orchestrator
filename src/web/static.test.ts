import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { serveStatic } from './static.js'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean()
})

it('serves only build files with appropriate types and cache policies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'grip-static-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const root = join(dir, 'dist')
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'index.html'), '<h1>Grip</h1>')
  await writeFile(join(root, 'assets', 'app-abcdefgh.js'), 'export {}')
  await writeFile(join(root, 'manifest.webmanifest'), '{}')
  await writeFile(join(root, 'sw.js'), 'worker')
  await writeFile(join(dir, 'secret.txt'), 'secret')
  let linked = true
  try {
    await symlink(join(dir, 'secret.txt'), join(root, 'leak.txt'))
  } catch {
    linked = false // Windows may disallow creating symlinks for the test user.
  }
  const get = async (path: string, method = 'GET') => {
    const result: { status: number; headers: Record<string, string>; body: string } = { status: 0, headers: {}, body: '' }
    const req = { url: path, method } as IncomingMessage
    const res = {
      writeHead(status: number, headers: Record<string, string>) {
        result.status = status
        result.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
      },
      end(body?: string | Buffer) {
        result.body = body?.toString() ?? ''
      },
    } as unknown as ServerResponse
    await serveStatic(req, res, root)
    return result
  }

  const page = await get('/')
  expect(page).toMatchObject({
    status: 200,
    body: '<h1>Grip</h1>',
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
  })
  expect(await get('/', 'HEAD')).toMatchObject({ status: 200, body: '' })
  expect((await get('/assets/app-abcdefgh.js')).headers).toMatchObject({
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'public, max-age=31536000, immutable',
  })
  expect((await get('/manifest.webmanifest')).headers).toMatchObject({
    'content-type': 'application/manifest+json; charset=utf-8',
    'cache-control': 'no-cache',
  })
  expect((await get('/sw.js')).headers['cache-control']).toBe('no-cache')
  for (const path of [
    '/assets/missing.js',
    '/unknown',
    '/assets/',
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/%2e%2e%2fsecret.txt',
    '/%5c..%5csecret.txt',
  ])
    expect((await get(path)).status).toBe(404)
  if (linked) expect((await get('/leak.txt')).status).toBe(404)
})
