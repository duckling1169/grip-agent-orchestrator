import type { RunStore } from '../runs/store.js'
import type { Chat, ChatStore } from './store.js'

export type TimelineEntry =
  | { kind: 'message'; at: string; from: 'user' | 'grip'; text: string | null }
  | { kind: 'reply'; at: string; text: string | null; error: string | null }
  | { kind: 'handoff'; at: string; runId: string; engine: string; title: string; brief: string }
  | { kind: 'to-worker'; at: string; runId: string; from: 'user' | 'orchestrator'; text: string | null }
  | { kind: 'worker-result'; at: string; runId: string; status: 'done' | 'failed'; error: string | null; preview: string | null }
  | { kind: 'stopped'; at: string; runId: string }
  | { kind: 'interrupted'; at: string; runId: string; reason: string }
  | { kind: 'read'; at: string; runId: string }

/** Reconstruct the visible thread from the event logs and turn files. */
export async function buildTimeline(chat: Chat, chatStore: ChatStore, runStore: RunStore): Promise<TimelineEntry[]> {
  const entries: TimelineEntry[] = []
  if (chat.kind === 'grip') {
    for (const e of chatStore.history(chat.id)) {
      if (e.t === 'turn-started') {
        const turn = await chatStore.turn(chat.id, e.turn)
        entries.push({ kind: 'message', at: e.at, from: e.from, text: turn.message })
      } else if (e.t === 'turn-ended') {
        const turn = await chatStore.turn(chat.id, e.turn)
        entries.push({ kind: 'reply', at: e.at, text: turn.output, error: e.error })
      }
    }
  }
  for (const run of runStore.list({ chatId: chat.id })) {
    for (const e of runStore.history(run.id)) {
      switch (e.t) {
        case 'created':
          entries.push({
            kind: 'handoff',
            at: e.at,
            runId: run.id,
            engine: run.engine,
            title: run.title,
            brief: run.brief.kind === 'text' ? run.brief.text : run.brief.path,
          })
          break
        case 'turn-started':
          if (e.turn > 1)
            entries.push({
              kind: 'to-worker',
              at: e.at,
              runId: run.id,
              from: e.fromUser ? 'user' : 'orchestrator',
              text: (await runStore.turn(run.id, e.turn)).message,
            })
          break
        case 'turn-ended': {
          const output = (await runStore.turn(run.id, e.turn)).output
          entries.push({
            kind: 'worker-result',
            at: e.at,
            runId: run.id,
            status: e.error ? 'failed' : 'done',
            error: e.error,
            preview: output?.slice(0, 400) ?? null,
          })
          break
        }
        case 'stopped':
          entries.push({ kind: 'stopped', at: e.at, runId: run.id })
          break
        case 'interrupted':
          entries.push({ kind: 'interrupted', at: e.at, runId: run.id, reason: e.reason })
          break
        case 'viewed':
          if (e.by !== 'app') entries.push({ kind: 'read', at: e.at, runId: run.id })
      }
    }
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at))
}
