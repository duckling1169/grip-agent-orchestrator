import type { EngineQuota, LeaderTurn } from '../contracts/api.js'
import type { Engine } from '../contracts/engines.js'
import { recoveryFor } from '../providers/recovery.js'
import { errorText } from '../errors.js'
import type { Log } from '../log.js'
import type { LeaderRunner, McpEndpoint } from '../runtime/leaders/leader.js'
import type { LeaderRunners } from '../runtime/leaders/runners.js'
import { renderInbox, withContext } from './prompt.js'
import type { ConversationStore, LeaderTurnEnding, ReceivedItem } from './store.js'

export type LeaderLoopOptions = {
  conversation: ConversationStore
  runners: LeaderRunners
  mcp: McpEndpoint
  cwd: string
  timeoutMs: number
  log: Log
  onTurnEnded?: (turn: LeaderTurn) => void
  seed?: (turnId: number) => string
  instructions?: () => string
  quota?: () => EngineQuota[]
  available?: (engine: Engine) => boolean
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
      await this.runTurn(begun.turn, begun.items, begun.nativeSessionId)
    }
  }

  private async runTurn(turn: LeaderTurn, items: ReceivedItem[], nativeSessionId: string | null): Promise<void> {
    let ending: LeaderTurnEnding
    let message = ''
    const recovery = (error: string | null) =>
      recoveryFor(turn.engine, error, this.options.quota?.() ?? [], this.options.available ?? (() => false))
    try {
      const exhausted = recovery(null)
      if (exhausted) {
        const failed = this.options.conversation.endTurn(turn.id, {
          status: 'failed',
          output: null,
          error: exhausted.reason,
          recovery: exhausted,
          nativeSessionId: null,
        })
        this.options.onTurnEnded?.(failed)
        return
      }
      const freshContext = this.options.seed?.(turn.id) ?? ''
      const instructions = this.options.instructions?.() ?? ''
      const prefix = [instructions, nativeSessionId ? '' : freshContext].filter(Boolean).join('\n\n')
      message = withContext(prefix, renderInbox(items))
      this.runner = this.options.runners(turn.engine)
      const reply = await this.runner.run({
        engine: turn.engine,
        model: turn.model,
        effort: turn.effort,
        nativeSessionId,
        sessionKey: String(turn.id),
        cwd: this.options.cwd,
        message,
        freshContext,
        mcp: this.options.mcp,
        timeoutMs: this.options.timeoutMs,
      })
      ending = {
        status: reply.error ? 'failed' : 'finished',
        output: reply.output || null,
        error: reply.error,
        nativeSessionId: reply.nativeSessionId,
        recovery: reply.error ? recovery(reply.error) : null,
        context: reply.context,
        inputChars: message.length,
      }
    } catch (error) {
      ending = {
        status: 'failed',
        output: null,
        error: errorText(error),
        recovery: recovery(errorText(error)),
        nativeSessionId: null,
        inputChars: message.length,
      }
    } finally {
      this.runner = null
    }
    const ended = this.options.conversation.endTurn(turn.id, ending)
    this.options.onTurnEnded?.(ended)
  }
}
