// Client for the HTTP API of Claw Orchestrator by Enderfga: https://github.com/Enderfga/claw-orchestrator

import { request as httpRequest } from 'node:http'

import type { ClawEngine, ClawPermissionMode, ClawSandboxMode } from '../../contracts/engines.js'
import { elapsedText, errorText } from '../../errors.js'

export type ClawHealth = { version: string; sessions: number }

export type ClawSession = { name: string; cwd: string; created: string }

export type StartSessionOptions = {
  name: string
  cwd: string
  engine: ClawEngine
  acpAgent?: string
  model?: string
  effort?: string
  resumeSessionId?: string
  mcpConfig?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  permissionMode?: ClawPermissionMode
  sandboxMode?: ClawSandboxMode
  appendSystemPrompt?: string
}

export type ClawSendResult = {
  output: string
  sessionId?: string
  error?: string
  permissionDenials?: { toolName: string }[]
}

export type ClawEvent = { time: string; type: string; content: string }

const HISTORY_LIMIT = 100

export type ClawSessions = Pick<ClawClient, 'startSession' | 'sendMessage' | 'stopSession' | 'listSessions' | 'history'>

export function replyText(sent: ClawSendResult): string {
  const denied = sent.permissionDenials ?? []
  if (denied.length === 0) return sent.output
  return `${sent.output}\n\n[moxy] ${denied.length} tool call(s) were denied: ${denied.map(denial => denial.toolName).join(', ')}`
}

export class ClawError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
    this.name = 'ClawError'
  }
}

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

  async listSessions(): Promise<ClawSession[]> {
    const body = await this.post<{ sessions?: unknown }>('/session/list', {})
    if (!Array.isArray(body.sessions)) throw new ClawError('/session/list: no sessions array', 200)
    return body.sessions as ClawSession[]
  }

  async startSession(options: StartSessionOptions): Promise<ClawSession> {
    return this.post<ClawSession>('/session/start', options, 120_000)
  }

  async sendMessage(name: string, message: string, options: { timeoutMs: number; effort?: string }): Promise<ClawSendResult> {
    const body: Record<string, unknown> = { name, message, timeout: options.timeoutMs }
    if (options.effort) body.effort = options.effort
    return this.post<ClawSendResult>('/session/send', body, options.timeoutMs + 60_000)
  }

  async stopSession(name: string): Promise<void> {
    await this.post('/session/stop', { name })
  }

  async history(name: string): Promise<ClawEvent[]> {
    const body = await this.post<{ matches?: unknown }>('/session/grep', { name, pattern: '.', limit: HISTORY_LIMIT })
    if (!Array.isArray(body.matches)) throw new ClawError('/session/grep: no matches array', 200)
    return body.matches as ClawEvent[]
  }

  private async post<T>(path: string, body: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
    const startedAt = Date.now()
    let reply: Reply
    try {
      reply = await request(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify(body),
        timeoutMs,
      })
    } catch (error) {
      throw new ClawError(`${path}: ${errorText(error)} ${elapsedText(startedAt)}`, null)
    }
    let parsed: { ok?: unknown; error?: unknown }
    try {
      parsed = JSON.parse(reply.text) as typeof parsed
    } catch {
      throw new ClawError(`${path}: HTTP ${reply.status} with a non-JSON body`, reply.status)
    }
    if (reply.status < 200 || reply.status >= 300 || parsed.ok !== true) {
      throw new ClawError(`${path}: ${typeof parsed.error === 'string' ? parsed.error : `HTTP ${reply.status}`}`, reply.status)
    }
    return parsed as T
  }
}
