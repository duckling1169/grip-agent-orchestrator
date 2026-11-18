import { realpath, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { GRIP_TOOLS } from '../runs/manager.js'
import type { ClawApi, RunManager } from '../runs/manager.js'
import { protectedFolderOf } from '../runs/protected.js'
import type { Engine, RunStore } from '../runs/store.js'
import type { Chat, ChatSender, ChatStore } from './store.js'
import { buildTimeline } from './timeline.js'
import { chatToken } from './token.js'

type Options = {
  chats: ChatStore
  runs: RunManager
  runStore: RunStore
  claw: ClawApi
  secret: string
  mcpUrl: () => string
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

  constructor(private readonly o: Options) {
    o.runStore.on('change', run => {
      if (run.chatId && (run.status === 'done' || run.status === 'failed') && !run.viewed)
        void this.noteWorkers(run.chatId).catch(() => undefined)
    })
  }

  async startChat(input: { folder: string; engine: Engine; model?: string; effort?: string; message: string }): Promise<Chat> {
    if (input.engine !== 'claude') throw new Error('Only Claude can host a chat today: Claw passes an MCP config to Claude sessions only.')
    if (!input.message.trim()) throw new Error('message is empty')
    const folder = await realpath(resolve(input.folder)).catch(() => {
      throw new Error(`folder not found: ${input.folder}`)
    })
    if (!(await stat(folder)).isDirectory()) throw new Error(`not a folder: ${input.folder}`)
    const guarded = protectedFolderOf(folder)
    if (guarded) throw new Error(`refusing to run a chat in ${folder}: it is inside protected folder ${guarded}`)
    const title = input.message
      .split(/\r?\n/)
      .find(line => line.trim())!
      .trim()
      .slice(0, 60)
    const chat = await this.o.chats.create({ kind: 'grip', title, folder, engine: input.engine, model: input.model, effort: input.effort })
    await writeFile(
      join(this.o.chats.chatDir(chat.id), 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          grip: { type: 'http', url: this.o.mcpUrl(), headers: { Authorization: `Bearer ${chatToken(this.o.secret, chat.id)}` } },
        },
      }),
    )
    return this.beginTurn(chat, input.message, 'user')
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
    return this.beginTurn(chat, text, 'user')
  }

  async stop(id: string): Promise<Chat> {
    let chat = this.must(id)
    this.queued.delete(id)
    this.stopping.add(id)
    if (this.busy.has(id) || chat.status === 'working') {
      await this.starting.get(id)?.catch(() => undefined)
      chat = await this.o.chats.markStopped(id)
      this.o.onActivityChange?.()
      if (chat.session) await this.o.claw.stopSession(chat.session).catch(() => undefined)
    } else if (chat.status !== 'stopped') chat = await this.o.chats.markStopped(id)
    await Promise.all(this.o.runStore.list({ chatId: id, status: 'running' }).map(run => this.o.runs.stop(run.id)))
    return chat
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
    const active = chats.filter(chat => chat.session && (chat.status === 'working' || this.busy.has(chat.id)))
    const results = await Promise.all(active.map(chat => this.stopWithin(chat.session!, options.graceMs ?? 5000)))
    const killed = results.includes(false) && options.kill !== false && !!this.o.killWorkers
    if (killed) await this.o.killWorkers!()
    return { stopped, killed }
  }

  private async stopWithin(session: string, graceMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.o.claw.stopSession(session).then(
          () => true,
          () => false,
        ),
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
    const sessions = await this.o.claw.listSessions().catch(() => [])
    for (const session of sessions)
      if (session.name.startsWith('grip-c-')) await this.o.claw.stopSession(session.name).catch(() => undefined)
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
        this.o.onTurnEnded?.('claude')
        void this.afterTurn(chat.id).catch(() => undefined)
      })
      .catch(() => undefined)
    return this.must(chat.id)
  }

  private async runTurn(chat: Chat, turn: number, message: string): Promise<void> {
    const session = chat.session!
    let result: { output: string; error: string | null; sessionId: string | null }
    try {
      await this.o.clawReady?.()
      if (this.stopping.has(chat.id)) throw new Error('stopped before the turn began')
      await this.o.claw.startSession({
        name: session,
        cwd: chat.folder!,
        engine: 'claude',
        ...(chat.model ? { model: chat.model } : {}),
        ...(chat.effort ? { effort: chat.effort } : {}),
        ...(chat.engineSessionId ? { resumeSessionId: chat.engineSessionId } : {}),
        mcpConfig: join(this.o.chats.chatDir(chat.id), 'mcp.json'),
        allowedTools: [GRIP_TOOLS],
      })
      if (this.stopping.has(chat.id)) throw new Error('stopped before the turn began')
      const sent = await this.o.claw.sendMessage(session, message, {
        timeoutMs: this.o.turnTimeoutMs ?? 2 * 60 * 60 * 1000,
        ...(chat.effort ? { effort: chat.effort } : {}),
      })
      const denied = sent.permissionDenials?.length
        ? `\n\n[grip] ${sent.permissionDenials.length} tool call(s) were denied: ${sent.permissionDenials.map(d => d.toolName).join(', ')}`
        : ''
      result = { output: sent.output + denied, error: sent.error ?? null, sessionId: sent.sessionId ?? null }
    } catch (error) {
      result = { output: '', error: (error as Error).message, sessionId: null }
    } finally {
      await this.o.claw.stopSession(session).catch(() => undefined)
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
