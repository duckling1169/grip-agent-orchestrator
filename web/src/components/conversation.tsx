import { Check, CircleAlert, Copy, RotateCw } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { ConversationEntry, LeaderSettings, LeaderTurn, Recovery } from '@contracts/api'
import { modelFamily } from '@contracts/engines'
import { MessageAttachments } from '@/components/attachments'
import { engineName } from '@/components/engine-icon'
import { Markdown } from '@/components/markdown'
import { WorkerIcon } from '@/components/worker-icon'
import { api } from '@/lib/api'
import { clockTime, elapsed } from '@/lib/format'
import { ghost, iconButton, linkButton, note, readingColumn, textButton, working } from '@/lib/styles'
import { cn } from '@/lib/utils'

const MOXY_MESSAGE = 'group/turn flex flex-col gap-1'
const USER_BUBBLE = 'max-w-[78%] self-end rounded-xl bg-accent px-3.5 py-2 whitespace-pre-wrap wrap-anywhere max-md:max-w-[85%]'
const AFTER_USER = '-mt-4 flex items-center gap-2.5 self-end text-xs'
const FAILED_NOTE = 'text-xs text-destructive'

type UserEntry = Extract<ConversationEntry, { type: 'user' }>
type Retry = (turnId: number, settings?: LeaderSettings) => void

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
      className="flex-1 overflow-auto px-7 pt-7 pb-3 max-md:px-4 max-md:pt-5 max-md:pb-2"
      onScroll={event => {
        const element = event.currentTarget
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40
      }}
    >
      <div className={cn(readingColumn, 'flex flex-col gap-5.5')} aria-live="polite">
        {entries.length === 0 && (
          <div className={MOXY_MESSAGE}>
            <p className="text-muted-foreground">Hi! What would you like to do?</p>
          </div>
        )}
        {entries.map(entry => {
          if (entry.type === 'moxy') {
            const turn = entry.turn
            const hasMark = turn.status === 'failed' && lastUserOfTurn.has(turn.id)
            if (turn.retried || hasMark) return null
            return (
              <MoxyTurn
                key={`moxy-${turn.id}`}
                turn={turn}
                offline={offline}
                onRetry={settings => act(() => api.retry(turn.id, settings))}
              />
            )
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
              onRetry={(turnId, settings) => act(() => api.retry(turnId, settings))}
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
  onRetry: Retry
  onSendNow: () => void
}) {
  const bubble = (
    <div
      className={cn(USER_BUBBLE, failed && 'min-w-0 max-w-none max-md:max-w-none')}
      data-testid="user-message"
      title={clockTime(entry.at)}
    >
      {entry.attachments?.length ? (
        <div className="flex flex-col gap-2">
          {entry.text && <div>{entry.text}</div>}
          <MessageAttachments files={entry.attachments} />
        </div>
      ) : (
        entry.text
      )}
    </div>
  )
  return (
    <>
      {failed ? (
        <div className="flex max-w-[82%] items-center gap-1.5 self-end" data-testid="failed-message">
          {bubble}
          <button
            className={cn(
              ghost,
              'group/mark min-h-0 flex-none rounded-full p-0.75 text-destructive hover:bg-destructive/5 [&_svg]:size-4.5',
            )}
            type="button"
            aria-label="Failed. Retry"
            title={`Failed: ${failed.error ?? 'Moxy could not reply'}. Click to retry.`}
            disabled={offline}
            onClick={() => onRetry(failed.id)}
          >
            <CircleAlert className="block group-hover/mark:hidden group-focus-visible/mark:hidden" />
            <RotateCw className="hidden group-hover/mark:block group-focus-visible/mark:block" />
          </button>
        </div>
      ) : (
        bubble
      )}
      {failed?.recovery && (
        <div className={AFTER_USER}>
          <TurnRecovery recovery={failed.recovery} offline={offline} onRetry={settings => onRetry(failed.id, settings)} />
        </div>
      )}
      {queued && (
        <div className={AFTER_USER}>
          <span className="text-2xs text-faint">Queued</span>
          <button
            className={textButton}
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

function MoxyTurn({ turn, offline, onRetry }: { turn: LeaderTurn; offline: boolean; onRetry: (settings?: LeaderSettings) => void }) {
  if (turn.status === 'running') return <Working turn={turn} />
  if (turn.status === 'failed')
    return (
      <div className={MOXY_MESSAGE} data-testid="moxy-message">
        <div className={FAILED_NOTE}>
          {turn.error ?? 'Moxy could not reply'}{' '}
          <button className={linkButton} type="button" disabled={offline} onClick={() => onRetry()}>
            Retry
          </button>
        </div>
        {turn.recovery && <TurnRecovery recovery={turn.recovery} offline={offline} onRetry={onRetry} />}
      </div>
    )
  if (!turn.output) return turn.status === 'stopped' ? <Stopped /> : null
  return (
    <div className={MOXY_MESSAGE} data-testid="moxy-message">
      <Markdown text={turn.output} />
      {turn.status === 'stopped' && <Stopped />}
      <Byline turn={turn} text={turn.output} />
    </div>
  )
}

function Stopped() {
  return (
    <div className={note} role="status">
      Stopped
    </div>
  )
}

function TurnRecovery({
  recovery,
  offline,
  onRetry,
}: {
  recovery: Recovery
  offline: boolean
  onRetry: (settings: LeaderSettings) => void
}) {
  const suggested = recovery.suggested
  return (
    <div className={FAILED_NOTE}>
      {engineName(recovery.provider)}: {recovery.reason}.{' '}
      {recovery.resetsAt ? (
        <>
          Resets <time dateTime={recovery.resetsAt}>{clockTime(recovery.resetsAt)}</time>.{' '}
        </>
      ) : (
        'Reset time unavailable. '
      )}
      {suggested && (
        <button className={linkButton} type="button" disabled={offline} onClick={() => onRetry(suggested)}>
          Switch to {engineName(suggested.engine)} and retry
        </button>
      )}
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
    <div className={working} role="status">
      <WorkerIcon family={modelFamily(turn.engine, turn.model)} running small />
      <span>Moxy is working · {elapsed(turn.startedAt, null)}</span>
    </div>
  )
}

function Byline({ turn, text }: { turn: LeaderTurn; text: string }) {
  const [copied, setCopied] = useState(false)
  const model = [turn.model ?? engineName(turn.engine), turn.effort].filter(Boolean).join(' ')
  return (
    <div className="flex min-h-5.5 items-center gap-1.5 text-xs text-faint opacity-0 transition-opacity group-focus-within/turn:opacity-100 group-hover/turn:opacity-100 max-md:opacity-100">
      <WorkerIcon family={modelFamily(turn.engine, turn.model)} small />
      <span>
        {model} · {clockTime(turn.endedAt ?? turn.startedAt)}
      </span>
      <button
        className={iconButton}
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
