/**
 * Claw's local HTTP API, as far as Grip uses it. Every route but `/health` needs the bearer
 * token; every answer is JSON with `ok`. The shapes here are the fields Grip reads, which the
 * health gate checks after each Claw update.
 */

export type ClawEngine = 'claude' | 'codex-app' | 'agy'

export type ClawHealth = { ok: boolean; version: string; sessions: number }

export type ClawSessionStats = { turns: number; [key: string]: unknown }

export type ClawSession = {
  name: string
  cwd: string
  created: string
  model?: string
  paused?: boolean
  stats: ClawSessionStats
  costUsd?: number
}

export type StartSessionOptions = {
  name: string
  cwd: string
  engine: ClawEngine
  model?: string
  effort?: string
  /** The engine's conversation to continue instead of starting a new one. */
  resumeSessionId?: string
  /** Claude only: MCP config files or JSON, passed as `--mcp-config`. */
  mcpConfig?: string | string[]
  /** Claude only: tools allowed without asking, and tools refused, as permission rules. */
  allowedTools?: string[]
  disallowedTools?: string[]
  /** Claude only: added to the system prompt, as `--append-system-prompt`. */
  appendSystemPrompt?: string
}

/** What a finished turn reports. Denied tool calls can leave a "successful" turn that did nothing. */
export type ClawSendResult = {
  output: string
  sessionId?: string
  error?: string
  permissionDenials?: { toolName: string }[]
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

type Fetch = typeof globalThis.fetch

export class ClawClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: Fetch = globalThis.fetch,
  ) {}

  /** The one unauthenticated route. Null when nothing answers on the port. */
  async health(timeoutMs = 2000): Promise<ClawHealth | null> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) return null
      const body = (await res.json()) as Partial<ClawHealth>
      return body.ok === true && typeof body.version === 'string'
        ? { ok: true, version: body.version, sessions: typeof body.sessions === 'number' ? body.sessions : 0 }
        : null
    } catch {
      return null
    }
  }

  private async post<T>(path: string, body: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new ClawError(`${path}: ${(error as Error).message}`, null)
    }
    let parsed: { ok?: unknown; error?: unknown } & Record<string, unknown>
    try {
      parsed = (await res.json()) as typeof parsed
    } catch {
      throw new ClawError(`${path}: HTTP ${res.status} with a non-JSON body`, res.status)
    }
    if (!res.ok || parsed.ok !== true) {
      throw new ClawError(`${path}: ${typeof parsed.error === 'string' ? parsed.error : `HTTP ${res.status}`}`, res.status)
    }
    return parsed as T
  }

  async listSessions(): Promise<ClawSession[]> {
    const body = await this.post<{ sessions: unknown }>('/session/list', {})
    if (!Array.isArray(body.sessions)) throw new ClawError('/session/list: no sessions array', 200)
    return body.sessions as ClawSession[]
  }

  async startSession(options: StartSessionOptions): Promise<ClawSession> {
    return this.post<ClawSession>('/session/start', options, 120_000)
  }

  /**
   * One turn: Claw answers only when the engine has finished it, so this waits as long as the
   * turn may take. `timeoutMs` is the turn's own limit; the HTTP wait allows a minute more.
   */
  async sendMessage(name: string, message: string, options: { timeoutMs: number; effort?: string }): Promise<ClawSendResult> {
    const body: Record<string, unknown> = { name, message, timeout: options.timeoutMs }
    if (options.effort) body.effort = options.effort
    return this.post<ClawSendResult>('/session/send', body, options.timeoutMs + 60_000)
  }

  async stopSession(name: string): Promise<void> {
    await this.post('/session/stop', { name })
  }
}

/** Does a value look like the session Grip reads? Used by the health gate. */
export function sessionShapeProblems(value: unknown): string[] {
  if (!value || typeof value !== 'object') return ['not an object']
  const s = value as Record<string, unknown>
  const problems: string[] = []
  for (const key of ['name', 'cwd', 'created'] as const) if (typeof s[key] !== 'string') problems.push(`${key} is not a string`)
  const stats = s.stats as Record<string, unknown> | undefined
  if (!stats || typeof stats !== 'object') problems.push('stats is missing')
  else if (typeof stats.turns !== 'number') problems.push('stats.turns is not a number')
  return problems
}
