// Client for the HTTP API of Claw Orchestrator by Enderfga: https://github.com/Enderfga/claw-orchestrator

import { request as httpRequest } from 'node:http'

export type ClawHealth = { version: string; sessions: number }

type Reply = { status: number; text: string }

function request(url: string, options: { method: string; headers?: Record<string, string>; body?: string; timeoutMs: number }) {
  return new Promise<Reply>((resolve, reject) => {
    const req = httpRequest(url, { method: options.method, headers: options.headers, agent: false }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      res.on('error', reject)
    })
    const timer = setTimeout(() => req.destroy(new Error(`no answer in ${Math.round(options.timeoutMs / 1000)} s`)), options.timeoutMs)
    req.on('close', () => clearTimeout(timer))
    req.on('error', reject)
    req.end(options.body)
  })
}

export class ClawClient {
  constructor(
    readonly baseUrl: string,
    readonly token: string,
  ) {}

  async health(timeoutMs = 2000): Promise<ClawHealth | null> {
    try {
      const reply = await request(`${this.baseUrl}/health`, { method: 'GET', timeoutMs })
      if (reply.status !== 200) return null
      const body = JSON.parse(reply.text) as { ok?: unknown; version?: unknown; sessions?: unknown }
      if (body.ok !== true || typeof body.version !== 'string') return null
      return { version: body.version, sessions: typeof body.sessions === 'number' ? body.sessions : 0 }
    } catch {
      return null
    }
  }
}
