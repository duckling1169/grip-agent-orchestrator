import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { JsonlAppender, readJsonl } from '../jsonl.js'
import type { Engine } from '../runs/store.js'

/**
 * `grip`: a chat Grip runs as a Claw session, which you talk to from the app.
 * `external`: a chat in Claude Code or another MCP host, known only by the calls it makes.
 */
export type ChatKind = 'grip' | 'external'

/** `idle` waits for you; `working` is in a turn. External chats are always `idle`. */
export type ChatStatus = 'idle' | 'working' | 'stopped' | 'failed'

/** Who sent a Grip chat a turn's message: you, or Grip's note that workers finished. */
export type ChatSender = 'user' | 'grip'

export type Chat = {
  id: string
  kind: ChatKind
  title: string
  /** The model that runs a Grip chat. Null for external chats, whose model Grip can't see. */
  engine: Engine | null
  model: string | null
  effort: string | null
  /** A Grip chat's folder; for an external chat, the folder of its first delegation. */
  folder: string | null
  /** The MCP client an external chat runs in, as it names itself (`claude-code`). */
  host: string | null
  /** The Claw session a Grip chat drives. */
  session: string | null
  engineSessionId: string | null
  status: ChatStatus
  error: string | null
  turns: number
  /** Turns whose message was Grip's note rather than yours. */
  fromGrip: number[]
  /** In a `wait_any` call now: waiting for its workers. Not logged; it only lasts a call. */
  waiting: boolean
  createdAt: string
  updatedAt: string
}

export type NewChat = Pick<Chat, 'kind' | 'title' | 'folder'> & Partial<Pick<Chat, 'engine' | 'model' | 'effort' | 'host'>>

/** One line of `chats.jsonl`. */
/** Model and effort for the next turns; null means the agent's default. */
export type TurnSettings = { model: string | null; effort: string | null }

export type ChatEvent =
  | { t: 'created'; at: string; chat: Chat }
  | { t: 'named'; at: string; id: string; title: string }
  | { t: 'turn-started'; at: string; id: string; turn: number; from: ChatSender }
  | { t: 'turn-ended'; at: string; id: string; turn: number; error: string | null; sessionId?: string }
  | { t: 'stopped'; at: string; id: string }
  | { t: 'interrupted'; at: string; id: string; reason: string }
  | { t: 'deleted'; at: string; id: string }
  | ({ t: 'configured'; at: string; id: string } & TurnSettings)

export type ChatStoreEvents = { change: [Chat] }

/**
 * Every chat Grip knows (design §5.1): an append-only log (`chats.jsonl`) plus one folder per
 * chat holding a Grip chat's MCP config and each turn's message and reply.
 */
export class ChatStore extends EventEmitter<ChatStoreEvents> {
  private readonly chats = new Map<string, Chat>()
  private readonly events = new Map<string, ChatEvent[]>()
  private readonly order = new Map<string, number>()
  /** Chats you deleted. Their log lines and turn files stay; Grip stops showing them. */
  private readonly deleted = new Set<string>()
  private seq = 0
  private readonly log: JsonlAppender

  private constructor(
    private readonly dir: string,
    private readonly now: () => Date,
  ) {
    super()
    this.setMaxListeners(0)
    this.log = new JsonlAppender(join(dir, 'chats.jsonl'))
  }

  static async open(dir: string, now: () => Date = () => new Date()): Promise<ChatStore> {
    await mkdir(join(dir, 'chats'), { recursive: true })
    const store = new ChatStore(dir, now)
    for (const event of await readJsonl<ChatEvent>(join(dir, 'chats.jsonl'))) store.apply(event)
    return store
  }

  /** The chat's own folder under `~/.grip/chats`. */
  chatDir(id: string): string {
    return join(this.dir, 'chats', id)
  }

  private stamp(): string {
    return this.now().toISOString()
  }

  private apply(e: ChatEvent): Chat | undefined {
    if (e.t === 'created') {
      this.chats.set(e.chat.id, { ...e.chat, waiting: false })
      this.events.set(e.chat.id, [e])
      this.order.set(e.chat.id, ++this.seq)
      return this.chats.get(e.chat.id)
    }
    const chat = this.chats.get(e.id)
    if (!chat) return undefined
    this.events.get(e.id)?.push(e)
    chat.updatedAt = e.at
    switch (e.t) {
      case 'named':
        chat.title = e.title
        break
      case 'turn-started':
        chat.status = 'working'
        chat.error = null
        chat.turns = Math.max(chat.turns, e.turn)
        if (e.from === 'grip') chat.fromGrip = [...chat.fromGrip, e.turn]
        break
      case 'turn-ended':
        chat.turns = Math.max(chat.turns, e.turn)
        chat.status = e.error ? 'failed' : 'idle'
        chat.error = e.error
        if (e.sessionId) chat.engineSessionId = e.sessionId
        break
      case 'stopped':
        chat.status = 'stopped'
        chat.waiting = false
        break
      case 'interrupted':
        chat.status = 'failed'
        chat.error = e.reason
        chat.waiting = false
        break
      case 'configured':
        chat.model = e.model
        chat.effort = e.effort
        break
      case 'deleted':
        this.deleted.add(e.id)
        chat.waiting = false
        break
    }
    return chat
  }

  private async record(e: ChatEvent): Promise<Chat> {
    const chat = this.apply(e)
    if (!chat) throw new Error(`unknown chat ${'id' in e ? e.id : e.chat.id}`)
    await this.log.append(e)
    const copy = structuredClone(chat)
    this.emit('change', copy)
    return copy
  }

  private must(id: string): Chat {
    const chat = this.deleted.has(id) ? undefined : this.chats.get(id)
    if (!chat) throw new Error(`unknown chat ${id}`)
    return chat
  }

  async create(input: NewChat): Promise<Chat> {
    const at = this.stamp()
    const id = `c-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    const chat: Chat = {
      id,
      kind: input.kind,
      title: input.title,
      engine: input.engine ?? null,
      model: input.model ?? null,
      effort: input.effort ?? null,
      folder: input.folder,
      host: input.host ?? null,
      session: input.kind === 'grip' ? `grip-${id}` : null,
      engineSessionId: null,
      status: 'idle',
      error: null,
      turns: 0,
      fromGrip: [],
      waiting: false,
      createdAt: at,
      updatedAt: at,
    }
    await mkdir(this.chatDir(id), { recursive: true })
    return this.record({ t: 'created', at, chat })
  }

  async rename(id: string, title: string): Promise<Chat> {
    if (this.must(id).title === title) return structuredClone(this.must(id))
    return this.record({ t: 'named', at: this.stamp(), id, title })
  }

  /** Change the model and effort the chat's next turns use. */
  async configure(id: string, settings: TurnSettings): Promise<Chat> {
    const chat = this.must(id)
    if (chat.model === settings.model && chat.effort === settings.effort) return structuredClone(chat)
    return this.record({ t: 'configured', at: this.stamp(), id, ...settings })
  }

  /** A message is going to a Grip chat. Returns the turn number. */
  async startTurn(id: string, message: string, from: ChatSender): Promise<number> {
    const turn = this.must(id).turns + 1
    await writeFile(join(this.chatDir(id), `turn-${turn}.in.md`), message)
    await this.record({ t: 'turn-started', at: this.stamp(), id, turn, from })
    return turn
  }

  async endTurn(
    id: string,
    turn: number,
    result: { output: string; error?: string | null; sessionId?: string | null },
    shouldFinish: () => boolean = () => true,
  ): Promise<Chat> {
    await this.saveOutput(id, turn, result.output)
    if (!shouldFinish()) return structuredClone(this.must(id))
    return this.record({
      t: 'turn-ended',
      at: this.stamp(),
      id,
      turn,
      error: result.error ?? null,
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    })
  }

  async saveOutput(id: string, turn: number, output: string): Promise<void> {
    this.must(id)
    await writeFile(join(this.chatDir(id), `turn-${turn}.out.md`), output)
  }

  async markStopped(id: string): Promise<Chat> {
    this.must(id)
    return this.record({ t: 'stopped', at: this.stamp(), id })
  }

  /** Stop showing a chat. Stop it and its workers first; this only hides it. */
  async delete(id: string): Promise<void> {
    this.must(id)
    await this.record({ t: 'deleted', at: this.stamp(), id })
  }

  isDeleted(id: string): boolean {
    return this.deleted.has(id)
  }

  /** Waiting in `wait_any` or not. Shown live in the app, never logged. */
  setWaiting(id: string, waiting: boolean): void {
    const chat = this.chats.get(id)
    if (!chat || chat.waiting === waiting) return
    chat.waiting = waiting
    this.emit('change', structuredClone(chat))
  }

  /** Fail every chat left mid-turn, for when Grip starts again. */
  async interruptWorking(reason: string): Promise<Chat[]> {
    const out: Chat[] = []
    for (const c of [...this.chats.values()].filter(c => c.status === 'working'))
      out.push(await this.record({ t: 'interrupted', at: this.stamp(), id: c.id, reason }))
    return out
  }

  get(id: string): Chat | null {
    if (this.deleted.has(id)) return null
    const chat = this.chats.get(id)
    return chat ? structuredClone(chat) : null
  }

  /** Chats, newest first. */
  list(): Chat[] {
    return [...this.chats.values()]
      .filter(c => !this.deleted.has(c.id))
      .sort((a, b) => (this.order.get(b.id) ?? 0) - (this.order.get(a.id) ?? 0))
      .map(c => structuredClone(c))
  }

  /** Grip chats in a turn now. They count as activity, like running workers. */
  working(): Chat[] {
    return this.list().filter(c => c.status === 'working')
  }

  history(id: string): ChatEvent[] {
    return structuredClone(this.events.get(id) ?? [])
  }

  async turn(id: string, turn: number): Promise<{ message: string | null; output: string | null }> {
    this.must(id)
    const read = (name: string) => readFile(join(this.chatDir(id), name), 'utf8').catch(() => null)
    const [message, output] = await Promise.all([read(`turn-${turn}.in.md`), read(`turn-${turn}.out.md`)])
    return { message, output }
  }
}
