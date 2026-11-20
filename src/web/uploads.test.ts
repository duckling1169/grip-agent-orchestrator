import { readdir, readFile, symlink, utimes } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'

import { describe, expect, it, onTestFinished, vi } from 'vitest'

import type { Moxy } from '../app.js'
import { HttpError, listenOnLoopback, sendJson } from '../http.js'
import { inboxPart } from '../moxy/prompt.js'
import { temporaryHome } from '../testing/harness.js'
import { ALLOWED_LOGIN, echoLeader, startTestMoxy, webCall as call, webJson as json } from '../testing/test-moxy.js'
import { UPLOAD_TYPE, Uploads } from './uploads.js'

function upload(moxy: Moxy, name: string, type: string, body: string | Uint8Array<ArrayBuffer>, headers = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${moxy.webPort}/api/uploads`, {
    method: 'POST',
    body,
    headers: {
      'Tailscale-User-Login': ALLOWED_LOGIN,
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(name),
      'X-File-Type': type,
      ...headers,
    },
  })
}

describe('web uploads', () => {
  it('stores attachments safely, serves them to authorized users, and delivers their paths to the leader', async () => {
    const leader = echoLeader()
    const moxy = await startTestMoxy({ leaders: () => leader })
    expect((await upload(moxy, 'test.png', 'image/png', 'data', { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await upload(moxy, 'test.png', 'image/png', 'data', { 'Tailscale-User-Login': '' })).status).toBe(401)
    const token = (await readFile(moxy.paths.webToken, 'utf8')).trim()
    expect(
      (await upload(moxy, 'test.png', 'image/png', 'data', { 'Tailscale-User-Login': 'outsider', Authorization: `Bearer ${token}` }))
        .status,
    ).toBe(403)
    const image = await json<{ id: string }>(upload(moxy, '../../test.png', 'image/png', 'data'))
    const file = await json<{ id: string }>(
      upload(moxy, 'notes.html', 'text/html', 'hello', { 'Tailscale-User-Login': '', Authorization: `Bearer ${token}` }),
    )
    const imagePath = join(moxy.paths.home, 'uploads', image.id, 'test.png')
    const filePath = join(moxy.paths.home, 'uploads', file.id, 'notes.html')
    expect(await readFile(imagePath, 'utf8')).toBe('data')
    const imageUrl = `/api/uploads/${image.id}`
    expect((await call(moxy, imageUrl, { headers: { 'Tailscale-User-Login': '' } })).status).toBe(401)
    expect((await call(moxy, `${imageUrl}/%2e%2e%2f%2e%2e%2fweb-token`)).status).toBe(404)
    await symlink(join(moxy.paths.uploads, image.id), join(moxy.paths.uploads, '01234567-89ab-cdef-0123-456789abcdef'), 'junction')
    expect((await call(moxy, '/api/uploads/01234567-89ab-cdef-0123-456789abcdef')).status).toBe(404)
    const inline = await call(moxy, imageUrl)
    expect(inline.headers.get('content-type')).toBe('image/png')
    expect(inline.headers.get('content-disposition')).toMatch(/^inline/)
    expect(await inline.text()).toBe('data')
    const download = await call(moxy, `/api/uploads/${file.id}`)
    expect(download.headers.get('content-type')).toBe('text/html')
    expect(download.headers.get('content-disposition')).toMatch(/^attachment/)
    expect(await download.text()).toBe('hello')
    const result = await call(moxy, '/api/messages', { method: 'POST', body: { text: '', attachments: [image.id, file.id] } })
    expect(result.status).toBe(200)
    await moxy.loop.idle()
    expect(leader.requests.map(request => inboxPart(request.message))).toEqual([
      `Attachments:\n- ${imagePath} (image/png, 4 bytes)\n- ${filePath} (text/html, 5 bytes)`,
    ])
    expect(await json(call(moxy, '/api/state'))).toMatchObject({
      conversation: expect.arrayContaining([
        expect.objectContaining({
          type: 'user',
          text: '',
          attachments: [
            { id: image.id, name: 'test.png', type: 'image/png', size: 4, path: imagePath },
            { id: file.id, name: 'notes.html', type: 'text/html', size: 5, path: filePath },
          ],
        }),
      ]) as unknown,
    })
    const withText = await call(moxy, '/api/messages', { method: 'POST', body: { text: 'Read this', attachments: [file.id] } })
    expect(withText.status).toBe(200)
    await moxy.loop.idle()
    expect(inboxPart(leader.requests.at(-1)!.message)).toBe(`Read this\n\nAttachments:\n- ${filePath} (text/html, 5 bytes)`)
  })

  it('rejects oversized uploads, excess attachments, and client-supplied file paths', async () => {
    const moxy = await startTestMoxy()
    const oversized = await upload(moxy, 'large.bin', '', new Uint8Array(25 * 1024 * 1024 + 1))
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toMatchObject({ error: expect.stringContaining('25 MB') as unknown })
    const streamed = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        `http://127.0.0.1:${moxy.webPort}/api/uploads`,
        {
          method: 'POST',
          headers: {
            'Tailscale-User-Login': ALLOWED_LOGIN,
            'Content-Type': 'application/octet-stream',
            'X-File-Name': 'stream.bin',
          },
        },
        res => {
          res.resume()
          res.on('end', () => resolve(res.statusCode))
          res.on('error', reject)
        },
      )
      req.on('error', reject)
      const mb = Buffer.alloc(1024 * 1024)
      for (let i = 0; i < 25; i++) req.write(mb)
      req.end('extra byte')
    })
    expect(streamed).toBe(413)
    expect(await readdir(moxy.paths.uploads)).toEqual([])
    const id = '12345678-1234-1234-1234-123456789abc'
    const tooMany = await call(moxy, '/api/messages', { method: 'POST', body: { text: 'hi', attachments: Array(11).fill(id) } })
    expect(tooMany.status).toBe(400)
    expect(await tooMany.json()).toMatchObject({ error: expect.stringContaining('10 files') as unknown })
    for (const [attachment, status] of [
      ['../web-token', 400],
      [id, 404],
    ] as const) {
      expect((await call(moxy, '/api/messages', { method: 'POST', body: { text: 'hi', attachments: [attachment] } })).status).toBe(status)
    }
    expect(moxy.conversation.conversation()).toEqual([])
  })
  it('sweeps expired drafts on upload and startup and keeps sent attachments', async () => {
    const home = await temporaryHome()
    const moxy = await startTestMoxy({ home })
    const save = (name: string) => json<{ id: string }>(upload(moxy, name, '', name))
    const sent = await save('sent.txt')
    const fresh = await save('fresh.txt')
    const ageMs = 25 * 60 * 60 * 1000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - ageMs)
    const abandoned = await save('abandoned.txt').finally(() => clock.mockRestore())
    expect((await call(moxy, '/api/messages', { method: 'POST', body: { attachments: [sent.id] } })).status).toBe(200)
    const old = new Date(Date.now() - ageMs)
    const age = (id: string) => utimes(join(moxy.paths.uploads, id), old, old)
    await age(sent.id)
    expect((await call(moxy, `/api/uploads/${abandoned.id}`)).status).toBe(200)
    const next = await save('next.txt')
    expect((await call(moxy, `/api/uploads/${abandoned.id}`)).status).toBe(404)
    expect((await call(moxy, `/api/uploads/${fresh.id}`)).status).toBe(200)
    await age(next.id)
    await moxy.stop()

    const restarted = await startTestMoxy({ home })
    expect((await call(restarted, `/api/uploads/${next.id}`)).status).toBe(404)
    expect(await (await call(restarted, `/api/uploads/${sent.id}`)).text()).toBe('sent.txt')
  })
})

async function uploadServer(budgetBytes: number, deadlineMs?: number) {
  const home = await temporaryHome()
  const uploads = new Uploads(home, budgetBytes, deadlineMs)
  await uploads.initialize(new Set())
  const server = await listenOnLoopback(0, async (req, res) => {
    try {
      sendJson(res, 200, await uploads.save(req))
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
      res.setHeader('Connection', 'close')
      req.resume()
      sendJson(res, error.status, { error: error.message })
    }
  })
  onTestFinished(() => server.close())
  const url = `http://127.0.0.1:${server.port}`
  const headers = { 'Content-Type': UPLOAD_TYPE, 'X-File-Name': 'file.txt' }
  return { home, uploads, url, headers, save: (body: string) => fetch(url, { method: 'POST', headers, body }) }
}

it('shares the pending byte budget across uploads and frees it after a message is recorded', async () => {
  const { save, uploads } = await uploadServer(10)
  const responses = await Promise.all([save('123456'), save('abcdef')])
  expect(responses.map(response => response.status).sort()).toEqual([200, 413])
  const draft = (await responses.find(response => response.ok)!.json()) as { id: string }
  await uploads.attach([draft.id], () => ({ received: false }))
  expect((await save('123456')).status).toBe(413)
  await uploads.attach([draft.id], () => ({ received: true }))
  expect((await save('123456')).status).toBe(200)
  expect(await uploads.get(draft.id)).toMatchObject({ size: 6 })
})

it('returns 408 and discards a stalled upload before the sender finishes its body', async () => {
  const { headers, home, save, url } = await uploadServer(10, 150)
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(url, { method: 'POST', headers, signal: AbortSignal.timeout(3000) }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.write('123456')
  })
  expect(status).toBe(408)
  expect(await readdir(home)).toEqual([])
  expect((await save('123456')).status).toBe(200)
})
