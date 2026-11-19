import { setTimeout as sleep } from 'node:timers/promises'

import type { ConversationEntry, LeaderTurn, PostedMessage, Snapshot } from '../contracts/api.js'

export class MoxyClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
  ) {}

  post(text: string, id?: string): Promise<PostedMessage> {
    return this.request<PostedMessage>('POST', '/api/messages', { text, ...(id ? { id } : {}) })
  }

  async conversation(): Promise<ConversationEntry[]> {
    return (await this.request<Snapshot>('GET', '/api/state')).conversation
  }

  async reply(source: string, pollMs = 1000): Promise<LeaderTurn> {
    for (;;) {
      const entries = await this.conversation()
      const message = entries.find(entry => entry.type === 'user' && entry.source === source)
      const turnId = message?.type === 'user' ? message.leaderTurnId : null
      const answer = entries.find(entry => entry.type === 'moxy' && entry.turn.id === turnId)
      if (answer?.type === 'moxy' && answer.turn.status !== 'running') return answer.turn
      await sleep(pollMs)
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const parsed = (await response.json()) as T & { error?: string }
    if (!response.ok) throw new Error(`${method} ${path}: ${parsed.error ?? `HTTP ${response.status}`}`)
    return parsed
  }
}
