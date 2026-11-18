import { realpath, stat } from 'node:fs/promises'
import { errorText } from '../errors.js'
import { basename, resolve } from 'node:path'

import type { ClawApi, RunManager } from '../runs/manager.js'
import { protectedFolderOf } from '../runs/protected.js'
import type { Engine, RunStore } from '../runs/store.js'
import type { Chat, ChatSender, ChatStore } from './store.js'
import { buildTimeline } from './timeline.js'
import { chatToken } from './token.js'
import { ClawChatTurns } from './turns.js'
import type { ChatTurns, TurnResult } from './turns.js'
import { DEFAULT_SETTINGS, minutes } from '../settings.js'

/** A chat's title: the first line of its first message. */
const titleOf = (message: string) =>
  message
    .split(/\r?\n/)
    .find(line => line.trim())!
    .trim()
    .slice(0, 60)

/** A chat started without a message keeps this title until its first one. */
const newChatTitle = (folder: string) => `New chat in ${basename(folder) || folder}`

type Options = {
  chats: ChatStore
  runs: RunManager
  runStore: RunStore
  claw: ClawApi
  secret: string
  mcpUrl: () => string
  /** How each engine leads a chat. Claude leads through Claw unless this says otherwise. */
  leaders?: Partial<Record<Engine, ChatTurns>>
  turnTimeoutMs?: number
  clawReady?: () => Promise<void>
  killWorkers?: () => Promise<void>
  onActivityChange?: () => void
  onTurnEnded?: (engine: Engine) => void
}

export class ChatManager {
  private readonly busy = new Set<string>()
  private readonly starting = new Map<string, Promise<number>>()
  private readonly stopping = new Set<string>()
  private readonly queued = new Map<string, string[]>()
  private readonly notified = new Set<string>()
  private readonly leaders: Partial<Record<Engine, ChatTurns>>

  constructor(private readonly o: Options) {
    this.leaders = { claude: new ClawChatTurns(o.claw, o.clawReady), ...o.leaders }
    o.runStore.on('change', run => {
      if (run.chatId && (run.status === 'done' || run.status === 'failed') && !run.viewed)
        void this.noteWorkers(run.chatId).catch(() => undefined)
    })
  }

  /** A new Grip chat in a folder. With a message its first turn starts at once; without, it waits for one. */
  async startChat(input: { folder: string; engine: Engine; model?: string; effort?: string; message?: string }): Promise<Chat> {
    if (!this.leaders[input.engine]) throw new Error(`${input.engine} can't lead a chat on this machine yet.`)
    const message = input.message?.trim() ? input.message : null
    const folder = await realpath(resolve(input.folder)).catch(() => {
      throw new Error(`folder not found: ${input.folder}`)
    })
    if (!(await stat(folder)).isDirectory()) throw new Error(`not a folder: ${input.folder}`)
    const guarded = protectedFolderOf(folder)
    if (guarded) throw new Error(`refusing to run a chat in ${folder}: it is inside protected folder ${guarded}`)
    const title = message ? titleOf(message) : newChatTitle(folder)
    const chat = await this.o.chats.create({ kind: 'grip', title, folder, engine: input.engine, model: input.model, effort: input.effort })
    return message ? this.beginTurn(chat, message, 'user') : chat
  }

  async message(id: string, text: string): Promise<Chat> {
    const chat = this.must(id)
    if (chat.kind !== 'grip') throw new Error('This chat runs in its own host; reply to it there.')
    if (!text.trim()) throw new Error('message is empty')
    if (this.stopping.has(id) && this.busy.has(id)) throw new Error('Chat is still stopping; try again when it has stopped.')
    if (this.busy.has(id) || chat.status === 'working') {
      const queued = this.queued.get(id) ?? []
      queued.push(text)
      this.queued.set(id, queued)
      return chat
    }
    // A chat started without a message takes its title from the first one.
    if (chat.turns === 0 && chat.folder && chat.title === newChatTitle(chat.folder)) await this.o.chats.rename(id, titleOf(text))
    return this.beginTurn(this.must(id), text, 'user')
  }

  async stop(id: string): Promise<Chat> {
    let chat = this.must(id)
    this.queued.delete(id)
    this.stopping.add(id)
    if (this.busy.has(id) || chat.status === 'working') {
      await this.starting.get(id)?.catch(() => undefined)
      chat = await this.o.chats.markStopped(id)
      this.o.onActivityChange?.()
      await this.leaderOf(chat)?.stop(chat)
    } else if (chat.status !== 'stopped') chat = await this.o.chats.markStopped(id)
    await Promise.all(this.o.runStore.list({ chatId: id, status: 'running' }).map(run => this.o.runs.stop(run.id)))
    return chat
  }

  /** Delete a chat: stop it and its workers if they are working, then stop showing it. */
  async delete(id: string): Promise<{ deleted: string }> {
    const chat = this.must(id)
    if (chat.kind === 'grip' && (chat.status === 'working' || this.busy.has(id))) await this.stop(id)
    else await Promise.all(this.o.runStore.list({ chatId: id, status: 'running' }).map(run => this.o.runs.stop(run.id)))
    this.queued.delete(id)
    await this.o.chats.delete(id)
    return { deleted: id }
  }

  async stopAll(options: { graceMs?: number; kill?: boolean } = {}): Promise<{ stopped: Chat[]; killed: boolean }> {
    const chats = this.o.chats.list().filter(chat => chat.kind === 'grip' && chat.status !== 'stopped')
    const stopped: Chat[] = []
    for (const chat of chats) {
      this.stopping.add(chat.id)
      this.queued.delete(chat.id)
    }
    for (const chat of chats) {
      await this.starting.get(chat.id)?.catch(() => undefined)
      stopped.push(await this.o.chats.markStopped(chat.id))
    }
    if (stopped.length) this.o.onActivityChange?.()
    const active = chats.filter(chat => chat.status === 'working' || this.busy.has(chat.id))
    const results = await Promise.all(active.map(chat => this.stopWithin(chat, options.graceMs ?? 5000)))
    const killed = results.includes(false) && options.kill !== false && !!this.o.killWorkers
    if (killed) await this.o.killWorkers!()
    return { stopped, killed }
  }

  private async stopWithin(chat: Chat, graceMs: number): Promise<boolean> {
    const leader = this.leaderOf(chat)
    if (!leader) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        leader.stop(chat).catch(() => false),
        new Promise<boolean>(resolve => {
          timer = setTimeout(() => resolve(false), graceMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async recover(reason = 'grip restarted'): Promise<Chat[]> {
    const interrupted = await this.o.chats.interruptWorking(reason)
    for (const leader of new Set(Object.values(this.leaders))) await leader.recover().catch(() => undefined)
    return interrupted
  }

  async externalChat(input: { host?: string; folder: string; title?: string }): Promise<Chat> {
    const label = input.host === 'claude-code' ? 'Claude Code' : input.host || 'MCP'
    return this.o.chats.create({
      kind: 'external',
      folder: input.folder,
      host: input.host,
      title: input.title || `${label} chat in ${basename(input.folder)}`,
    })
  }

  rename(id: string, title: string): Promise<Chat> {
    return this.o.chats.rename(id, title)
  }
  setWaiting(id: string, waiting: boolean): void {
    this.o.chats.setWaiting(id, waiting)
  }
  get(id: string): Chat | null {
    return this.o.chats.get(id)
  }
  list(): Chat[] {
    return this.o.chats.list()
  }
  timeline(id: string) {
    return buildTimeline(this.must(id), this.o.chats, this.o.runStore)
  }

  private leaderOf(chat: Chat): ChatTurns | undefined {
    return chat.engine ? this.leaders[chat.engine] : undefined
  }

  private must(id: string): Chat {
    const chat = this.o.chats.get(id)
    if (!chat) throw new Error(`unknown chat ${id}`)
    return chat
  }

  private async beginTurn(chat: Chat, message: string, from: ChatSender): Promise<Chat> {
    this.busy.add(chat.id)
    this.stopping.delete(chat.id)
    let turn: number
    const starting = this.o.chats.startTurn(chat.id, message, from)
    this.starting.set(chat.id, starting)
    try {
      turn = await starting
    } catch (error) {
      this.busy.delete(chat.id)
      throw error
    } finally {
      this.starting.delete(chat.id)
    }
    this.o.onActivityChange?.()
    void this.runTurn(chat, turn, message)
      .finally(() => {
        this.busy.delete(chat.id)
        this.o.onActivityChange?.()
        if (chat.engine) this.o.onTurnEnded?.(chat.engine)
        void this.afterTurn(chat.id).catch(() => undefined)
      })
      .catch(() => undefined)
    return this.must(chat.id)
  }

  private async runTurn(chat: Chat, turn: number, message: string): Promise<void> {
    let result: TurnResult
    try {
      const leader = this.leaderOf(chat)
      if (!leader) throw new Error(`${chat.engine} can't lead a chat on this machine`)
      result = await leader.run({
        chat,
        message,
        mcp: { url: this.o.mcpUrl(), token: chatToken(this.o.secret, chat.id) },
        chatDir: this.o.chats.chatDir(chat.id),
        timeoutMs: this.o.turnTimeoutMs ?? minutes(DEFAULT_SETTINGS.turnTimeoutMinutes),
        stopped: () => this.stopping.has(chat.id),
      })
    } catch (error) {
      result = { output: '', error: errorText(error), sessionId: null }
    }
    if (this.stopping.has(chat.id)) await this.o.chats.saveOutput(chat.id, turn, result.output)
    else await this.o.chats.endTurn(chat.id, turn, result, () => !this.stopping.has(chat.id))
  }

  private async afterTurn(id: string): Promise<void> {
    const chat = this.must(id)
    if (chat.status === 'stopped') return
    const messages = this.queued.get(id)
    if (messages?.length) {
      this.queued.delete(id)
      await this.beginTurn(chat, messages.join('\n\n'), 'user')
    } else await this.noteWorkers(id)
  }

  private async noteWorkers(id: string): Promise<void> {
    const chat = this.o.chats.get(id)
    if (
      !chat ||
      chat.kind !== 'grip' ||
      chat.status === 'working' ||
      chat.status === 'stopped' ||
      this.busy.has(id) ||
      this.stopping.has(id)
    )
      return
    const runs = this.o.runStore
      .list({ chatId: id })
      .filter(r => (r.status === 'done' || r.status === 'failed') && !r.viewed && !this.notified.has(`${r.id}:${r.turns}`))
    if (!runs.length) return
    for (const run of runs) this.notified.add(`${run.id}:${run.turns}`)
    const text = `[grip] These workers finished and you have not read them yet:\n${runs.map(r => `- ${r.title} (${r.engine}, run ${r.id}, ${r.status})`).join('\n')}\nRead each with wait_any or result.`
    await this.beginTurn(chat, text, 'grip')
  }
}
