import type { ClawSendResult, ClawSession, StartSessionOptions } from '../claw/client.js'
import type { ClawApi } from '../runs/manager.js'

/** A Claw that answers each turn when the test says so. */
export class FakeClaw implements ClawApi {
  sessions = new Map<string, StartSessionOptions>()
  starts: StartSessionOptions[] = []
  sends: { name: string; message: string }[] = []
  /** When set, stopSession never answers, like a Claw that has hung. */
  hangStops = false
  private pending = new Map<string, { resolve: (r: ClawSendResult) => void; reject: (e: Error) => void }>()

  async startSession(o: StartSessionOptions): Promise<ClawSession> {
    this.starts.push(o)
    this.sessions.set(o.name, o)
    return { name: o.name, cwd: o.cwd, created: new Date().toISOString(), stats: { turns: 0 } }
  }
  sendMessage(name: string, message: string): Promise<ClawSendResult> {
    this.sends.push({ name, message })
    return new Promise((resolve, reject) => this.pending.set(name, { resolve, reject }))
  }
  async stopSession(name: string) {
    if (this.hangStops) return new Promise<void>(() => undefined)
    this.sessions.delete(name)
    this.pending.get(name)?.reject(new Error(`Session '${name}' was stopped`))
    this.pending.delete(name)
  }
  async listSessions(): Promise<ClawSession[]> {
    return [...this.sessions.values()].map(o => ({ name: o.name, cwd: o.cwd, created: '', stats: { turns: 0 } }))
  }
  /** Finish the turn in flight on a session. */
  answer(name: string, result: ClawSendResult) {
    this.pending.get(name)?.resolve(result)
    this.pending.delete(name)
  }
  async waitForSend(name: string) {
    for (let i = 0; i < 200 && !this.pending.has(name); i++) await new Promise(r => setTimeout(r, 5))
  }
}
