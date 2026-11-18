import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, expect, it } from 'vitest'

import { ClawClient } from './client.js'

let close: (() => void) | null = null
afterEach(() => close?.())

/** A Claw that answers every send after `delayMs`, as a turn does when it ends. */
function slowClaw(delayMs: number) {
  const server = createServer((req, res) => {
    req.resume()
    const timer = setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, output: 'done' }))
    }, delayMs)
    res.on('close', () => clearTimeout(timer))
  })
  return new Promise<ClawClient>(resolve =>
    server.listen(0, '127.0.0.1', () => {
      close = () => server.close()
      resolve(new ClawClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'token'))
    }),
  )
}

it('waits for a turn that answers late', async () => {
  const client = await slowClaw(300)
  expect(await client.sendMessage('s', 'hi', { timeoutMs: 60_000 })).toMatchObject({ output: 'done' })
})

it("gives up only at Grip's own limit", async () => {
  const client = await slowClaw(5_000)
  // The HTTP wait allows a minute past the turn's limit, so post through a short stop instead.
  await expect(
    (client as unknown as { post: (p: string, b: object, t: number) => Promise<unknown> }).post('/session/send', {}, 100),
  ).rejects.toThrow('/session/send: no answer in')
})
