import type { ClawSendResult, ClawSession, ClawSessions, StartSessionOptions } from '../runtime/claw/client.js'

type PendingTurn = { resolve: (result: ClawSendResult) => void; reject: (error: Error) => void }

export class FakeClaw implements ClawSessions {
  readonly sessions = new Map<string, StartSessionOptions>()
  readonly starts: StartSessionOptions[] = []
  readonly sends: { name: string; message: string }[] = []
  readonly stops: string[] = []
  private readonly pending = new Map<string, PendingTurn>()

  async startSession(options: StartSessionOptions): Promise<ClawSession> {
    this.starts.push(options)
    this.sessions.set(options.name, options)
    return { name: options.name, cwd: options.cwd, created: new Date().toISOString() }
  }

  sendMessage(name: string, message: string): Promise<ClawSendResult> {
    this.sends.push({ name, message })
    return new Promise((resolve, reject) => this.pending.set(name, { resolve, reject }))
  }

  async stopSession(name: string): Promise<void> {
    this.stops.push(name)
    this.sessions.delete(name)
    this.pending.get(name)?.reject(new Error(`Session '${name}' was stopped`))
    this.pending.delete(name)
  }

  async listSessions(): Promise<ClawSession[]> {
    return [...this.sessions.values()].map(options => ({ name: options.name, cwd: options.cwd, created: '' }))
  }

  answer(name: string, result: ClawSendResult): void {
    this.pending.get(name)?.resolve(result)
    this.pending.delete(name)
  }

  fail(name: string, error: Error): void {
    this.pending.get(name)?.reject(error)
    this.pending.delete(name)
  }

  async turnStarted(name: string): Promise<void> {
    for (let attempt = 0; attempt < 400 && !this.pending.has(name); attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    if (!this.pending.has(name)) throw new Error(`no turn started on ${name}`)
  }
}
