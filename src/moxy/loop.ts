import type { LeaderTurn } from '../contracts/api.js'
import { errorText } from '../errors.js'
import type { Log } from '../log.js'
import type { LeaderRunner, McpEndpoint } from '../runtime/leaders/leader.js'
import type { LeaderRunners } from '../runtime/leaders/runners.js'
import { renderInbox } from './prompt.js'
import type { ConversationStore, LeaderTurnEnding, ReceivedItem } from './store.js'

export type LeaderLoopOptions = {
  conversation: ConversationStore
  runners: LeaderRunners
  mcp: McpEndpoint
  cwd: string
  timeoutMs: number
  log: Log
  onTurnEnded?: (turn: LeaderTurn) => void
}

export class LeaderLoop {
  private draining: Promise<void> | null = null
  private wakeAgain = false
  private closed = false
  private runner: LeaderRunner | null = null

  constructor(private readonly options: LeaderLoopOptions) {}

  wake(): void {
    if (this.closed) return
    if (this.draining) {
      this.wakeAgain = true
      return
    }
    this.draining = this.drain()
      .catch(error => this.options.log(`leader loop failed: ${errorText(error)}`))
      .finally(() => {
        this.draining = null
        if (this.wakeAgain) {
          this.wakeAgain = false
          this.wake()
        }
      })
  }

  stop(): Promise<boolean> {
    return this.halt(this.options.conversation.stopRunningTurn('Stopped by the user'))
  }

  sendNow(): Promise<boolean> {
    return this.halt(this.options.conversation.interruptRunningTurn('Stopped so Moxy could read the newer messages'))
  }

  async idle(): Promise<void> {
    while (this.draining) await this.draining
  }

  async close(): Promise<void> {
    this.closed = true
    const interrupted = this.options.conversation.interruptRunningTurn('Moxy stopped during this turn')
    if (interrupted) this.options.log(`interrupted leader turn ${interrupted.id}`)
    await this.runner?.stop()
    await this.idle()
  }

  private async halt(turn: LeaderTurn | null): Promise<boolean> {
    if (!turn) return false
    await this.runner?.stop()
    return true
  }

  private async drain(): Promise<void> {
    while (!this.closed) {
      const begun = this.options.conversation.beginTurn()
      if (!begun) return
      await this.runTurn(begun.turn, begun.items)
    }
  }

  private async runTurn(turn: LeaderTurn, items: ReceivedItem[]): Promise<void> {
    let ending: LeaderTurnEnding
    try {
      this.runner = this.options.runners(turn.engine)
      const reply = await this.runner.run({
        engine: turn.engine,
        model: turn.model,
        effort: turn.effort,
        nativeSessionId: this.options.conversation.leader().nativeSessionId,
        cwd: this.options.cwd,
        message: renderInbox(items),
        mcp: this.options.mcp,
        timeoutMs: this.options.timeoutMs,
      })
      ending = {
        status: reply.error ? 'failed' : 'finished',
        output: reply.output || null,
        error: reply.error,
        nativeSessionId: reply.nativeSessionId,
      }
    } catch (error) {
      ending = { status: 'failed', output: null, error: errorText(error), nativeSessionId: null }
    } finally {
      this.runner = null
    }
    this.options.onTurnEnded?.(this.options.conversation.endTurn(turn.id, ending))
  }
}
