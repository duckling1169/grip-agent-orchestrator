import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DEFAULT_WEB_PORT } from '../web/server.js'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Grip's web API on this machine, as `grip status` and `grip stop-all` call it. */
export class LocalApi {
  constructor(
    private readonly home: string,
    private readonly port = DEFAULT_WEB_PORT,
  ) {}

  private get base() {
    return `http://127.0.0.1:${this.port}`
  }

  /** Whether a Grip answers on this machine's web port. */
  async running(): Promise<boolean> {
    try {
      const response = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(3000) })
      const body = (await response.json()) as { app?: unknown }
      return response.ok && body.app === 'grip'
    } catch {
      return false
    }
  }

  /** The MCP token doubles as the local key; only you can read it, in Grip's home. */
  private async token(): Promise<string> {
    try {
      return (await readFile(join(this.home, 'mcp-token'), 'utf8')).trim()
    } catch {
      throw new Error(`No Grip token in ${this.home}. Run grip install first.`)
    }
  }

  async call<T>(path: string, method: 'GET' | 'POST' = 'GET'): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.token()}` }
    if (method === 'POST') headers['Content-Type'] = 'application/json'
    let response: Response
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers,
        ...(method === 'POST' ? { body: '{}' } : {}),
        signal: AbortSignal.timeout(60_000),
      })
    } catch {
      throw new Error(`Grip is not running on this machine (nothing answers on port ${this.port}).`)
    }
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null
    if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : `Grip returned HTTP ${response.status}`)
    return body as T
  }

  /**
   * Wait until the Grip process has exited, which it does only once Claw has stopped too, or give
   * up after the limit.
   */
  async waitUntilExited(pid: number, limitMs: number): Promise<boolean> {
    const until = Date.now() + limitMs
    while (Date.now() < until) {
      if (!alive(pid)) return true
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    return !alive(pid)
  }

  /** Wait until Grip answers, or give up after the limit. */
  async waitUntilRunning(limitMs: number): Promise<boolean> {
    const until = Date.now() + limitMs
    while (Date.now() < until) {
      if (await this.running()) return true
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    return false
  }
}
