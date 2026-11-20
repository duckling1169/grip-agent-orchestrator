import { request } from 'node:http'

import { expect, it, onTestFinished } from 'vitest'

import { listenOnLoopback } from '../http.js'
import { writeCheck } from './identity.js'

it('accepts only its own HTTPS tailnet origin and matching local HTTP origins', async () => {
  const tailnetHost = 'moxy.tail-example.ts.net'
  const check = writeCheck(async () => tailnetHost)
  const server = await listenOnLoopback(0, async (req, res) => {
    res.writeHead((await check(req)) ? 403 : 200).end()
  })
  onTestFinished(() => server.close())

  const post = (host: string, origin?: string, forwardedHost?: string) =>
    new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        `http://127.0.0.1:${server.port}`,
        {
          method: 'POST',
          headers: {
            Host: host,
            'Content-Type': 'application/json',
            ...(origin ? { Origin: origin } : {}),
            ...(forwardedHost ? { 'X-Forwarded-Host': forwardedHost } : {}),
          },
        },
        res => {
          res.resume()
          res.on('end', () => resolve(res.statusCode))
          res.on('error', reject)
        },
      )
      req.on('error', reject)
      req.end('{}')
    })

  const local = `localhost:${server.port}`
  const wrongPort = `localhost:${server.port + 1}`
  expect(await post(local)).toBe(200)
  expect(await post(local, `http://${local}`)).toBe(200)
  expect(await post(local, `http://${wrongPort}`)).toBe(403)
  expect(await post(tailnetHost, `https://${tailnetHost}`)).toBe(200)
  expect(await post(`${tailnetHost}:443`, `https://${tailnetHost}`)).toBe(200)
  expect(await post(tailnetHost, `http://${tailnetHost}`)).toBe(403)
  expect(await post(tailnetHost, `https://${tailnetHost}:444`)).toBe(403)
  expect(await post('other.tail-example.ts.net', `https://${tailnetHost}`, tailnetHost)).toBe(403)
  expect(await post('other.tail-example.ts.net')).toBe(403)
})
