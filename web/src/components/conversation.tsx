import { Check, CircleAlert, Copy, RotateCw } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { ConversationEntry, LeaderTurn } from '@contracts/api'
import { engineName } from '@/components/engine-icon'
import { Markdown } from '@/components/markdown'
import { WorkerIcon } from '@/components/worker-icon'
import { api } from '@/lib/api'
import { clockTime, elapsed } from '@/lib/format'

type UserEntry = Extract<ConversationEntry, { type: 'user' }>

export function Conversation({
  entries,
  offline,
  onError,
}: {
  entries: ConversationEntry[]
  offline: boolean
  onError: (message: string) => void
}) {
  const stream = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const turns = new Map(entries.flatMap(entry => (entry.type === 'moxy' ? [[entry.turn.id, entry.turn] as const] : [])))
  const lastUserOfTurn = new Map<number, number>()
  for (const entry of entries)
    if (entry.type === 'user' && entry.leaderTurnId !== null) lastUserOfTurn.set(entry.leaderTurnId, entry.inboxId)
  const running = entries.some(entry => entry.type === 'moxy' && entry.turn.status === 'running')

  useLayoutEffect(() => {
    if (pinned.current && stream.current) stream.current.scrollTop = stream.current.scrollHeight
  }, [entries])

  const act = (action: () => Promise<unknown>) =>
    void action().catch(error => onError(error instanceof Error ? error.message : String(error)))

  return (
    <div
      ref={stream}
      className="stream"
      onScroll={event => {
        const element = event.currentTarget
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40
      }}
    >
      <div className="column" aria-live="polite">
        {entries.length === 0 && (
          <div className="msg-moxy">
            <p className="empty-greeting">Hi! What would you like to do?</p>
          </div>
        )}
        {entries.map(entry => {
          if (entry.type === 'moxy') {
            const turn = entry.turn
            const hasMark = turn.status === 'failed' && lastUserOfTurn.has(turn.id)
            if (turn.retried || hasMark) return null
            return <MoxyTurn key={`moxy-${turn.id}`} turn={turn} offline={offline} onRetry={() => act(() => api.retry(turn.id))} />
          }
          const turn = entry.leaderTurnId === null ? null : turns.get(entry.leaderTurnId)
          const failed = turn?.status === 'failed' && !turn.retried && lastUserOfTurn.get(turn.id) === entry.inboxId ? turn : null
          return (
            <UserMessage
              key={`user-${entry.inboxId}`}
              entry={entry}
              failed={failed}
              queued={entry.leaderTurnId === null && running}
              offline={offline}
              onRetry={turnId => act(() => api.retry(turnId))}
              onSendNow={() => act(() => api.sendNow())}
            />
          )
        })}
      </div>
    </div>
  )
}

function UserMessage({
  entry,
  failed,
  queued,
  offline,
  onRetry,
  onSendNow,
}: {
  entry: UserEntry
  failed: LeaderTurn | null
  queued: boolean
  offline: boolean
  onRetry: (turnId: number) => void
  onSendNow: () => void
}) {
  const bubble = (
    <div className="msg-user" title={clockTime(entry.at)}>
      {entry.text}
    </div>
  )
  return (
    <>
      {failed ? (
        <div className="user-line">
          {bubble}
          <button
            className="ghost fail-mark"
            type="button"
            aria-label="Failed. Retry"
            title={`Failed: ${failed.error ?? 'Moxy could not reply'}. Click to retry.`}
            disabled={offline}
            onClick={() => onRetry(failed.id)}
          >
            <CircleAlert className="idle" />
            <RotateCw className="hover-only" />
          </button>
        </div>
      ) : (
        bubble
      )}
      {queued && (
        <div className="after-user">
          <span className="next">Queued</span>
          <button
            className="ghost text-action"
            type="button"
            title="Stop Moxy's current turn and start a new one with this message"
            disabled={offline}
            onClick={onSendNow}
          >
            Send now
          </button>
        </div>
      )}
    </>
  )
}

function MoxyTurn({ turn, offline, onRetry }: { turn: LeaderTurn; offline: boolean; onRetry: () => void }) {
  if (turn.status === 'running') return <Working turn={turn} />
  if (turn.status === 'failed')
    return (
      <div className="msg-moxy">
        <div className="note-line fail">
          {turn.error ?? 'Moxy could not reply'}{' '}
          <button className="ghost link" type="button" disabled={offline} onClick={onRetry}>
            Retry
          </button>
        </div>
      </div>
    )
  if (!turn.output) return turn.status === 'stopped' ? <div className="note-line">Stopped</div> : null
  return (
    <div className="msg-moxy">
      <Markdown text={turn.output} />
      {turn.status === 'stopped' && <div className="note-line">Stopped</div>}
      <Byline turn={turn} text={turn.output} />
    </div>
  )
}

function Working({ turn }: { turn: LeaderTurn }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="working" role="status">
      <WorkerIcon engine={turn.engine} running small />
      <span>Moxy is working · {elapsed(turn.startedAt, null)}</span>
    </div>
  )
}

function Byline({ turn, text }: { turn: LeaderTurn; text: string }) {
  const [copied, setCopied] = useState(false)
  const model = [turn.model ?? engineName(turn.engine), turn.effort].filter(Boolean).join(' ')
  return (
    <div className="byline">
      <WorkerIcon engine={turn.engine} small />
      <span>
        {model} · {clockTime(turn.endedAt ?? turn.startedAt)}
      </span>
      <button
        className="ghost icon-action"
        type="button"
        aria-label="Copy response"
        title="Copy"
        onClick={() =>
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          })
        }
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  )
}
