import { ArrowUpRight } from 'lucide-react'
import { useLayoutEffect, useRef, type ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'

import { api } from '../api.js'
import { useMediaQuery } from '../browser.js'
import { runHref, useDetail } from '../state.js'
import type { ChatSummary, Engine, RunSummary, TimelineEntry } from '../types.js'
import {
  ChatStatus,
  CopyButton,
  EngineMark,
  engineNames,
  ErrorBanner,
  focusRing,
  folderName,
  hostName,
  isEngine,
  Markdown,
  runActivity,
  StatusDot,
  Time,
  touchButton,
} from './common.js'
import { Composer, TurnSettings } from './composer.js'
import { ChatDetails, DetailsColumn, WIDE } from './details.js'
import { composerFrame, contentWidth, LoadNotice, scrollFrame, textLink, viewportSelector, WorkspaceHeader } from './workspace-layout.js'

function WorkerCard({
  href,
  engine,
  title,
  status,
  meta,
  children,
}: {
  href: string
  engine?: Engine
  title: string
  status?: ReactNode
  meta: ReactNode
  children: ReactNode
}) {
  return (
    <li className="min-w-0">
      <Card className="gap-3 overflow-hidden py-0 pb-4 shadow-none">
        <CardHeader className="gap-2 px-0 pt-0">
          <a
            href={href}
            className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-4 pt-4 pb-2 transition-colors hover:bg-muted focus-visible:bg-muted ${focusRing}`}
          >
            {engine && <EngineMark engine={engine} />}
            <strong className="min-w-0 flex-1 text-sm font-medium wrap-anywhere">{title}</strong>
            {status && (
              <Badge variant="secondary" className="gap-1.5 font-normal">
                {status}
              </Badge>
            )}
            <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </a>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-4 text-xs text-muted-foreground">{meta}</div>
        </CardHeader>
        {children && <CardContent className="grid min-w-0 gap-2 px-4 text-sm">{children}</CardContent>}
      </Card>
    </li>
  )
}

function TimelineItem({ entry, runs, now }: { entry: TimelineEntry; runs: RunSummary[]; now: number }) {
  if (entry.kind === 'message' || entry.kind === 'reply') {
    // Yours sit on the right in a bubble and Claude's on the left, so neither needs a name. A note
    // Grip sent the chat is neither, so it alone says where it came from.
    const user = entry.kind === 'message' && entry.from === 'user'
    const fromGrip = entry.kind === 'message' && entry.from === 'grip'
    return (
      <li className={`grid min-w-0 gap-1 wrap-anywhere ${user ? 'ml-auto max-w-[92%] justify-items-end' : ''}`}>
        {entry.text && (
          <div className={user ? 'min-w-0 rounded-xl rounded-br-sm border bg-muted/50 px-4 py-3' : 'min-w-0'}>
            <Markdown text={entry.text} />
          </div>
        )}
        {entry.kind === 'reply' && <ErrorBanner text={entry.error} />}
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          {entry.text && <CopyButton text={entry.text} />}
          {fromGrip && <span>Grip</span>}
          <Time at={entry.at} />
        </div>
      </li>
    )
  }

  const run = runs.find(item => item.id === entry.runId)
  const target = runHref(entry.runId)
  if (entry.kind === 'handoff') {
    return (
      <WorkerCard
        href={target}
        engine={isEngine(entry.engine) ? entry.engine : undefined}
        title={entry.title}
        status={
          run && (
            <>
              <StatusDot status={run.status} engine={run.engine} />
              {runActivity(run, now, true)}
            </>
          )
        }
        meta={
          <>
            <span>Delegated</span>
            <Time at={entry.at} />
            {run?.branch && (
              <code className="min-w-0 wrap-anywhere" title={run.branch}>
                {run.branch}
              </code>
            )}
          </>
        }
      >
        <p className="wrap-anywhere whitespace-pre-wrap text-muted-foreground">{entry.brief}</p>
      </WorkerCard>
    )
  }
  if (entry.kind === 'worker-result') {
    return (
      <WorkerCard
        href={target}
        engine={run?.engine}
        title={run?.title ?? 'Worker'}
        status={
          <>
            <StatusDot status={entry.status} engine={run?.engine} />
            {entry.status === 'done' ? 'Done' : 'Failed'}
          </>
        }
        meta={
          <>
            <span>Worker result</span>
            <Time at={entry.at} />
            {entry.preview && <CopyButton text={entry.preview} label="Copy result" className="ml-auto self-center" />}
          </>
        }
      >
        {entry.preview && <Markdown text={entry.preview} />}
        <ErrorBanner text={entry.error} />
      </WorkerCard>
    )
  }
  if (entry.kind === 'to-worker') {
    return (
      <li className="grid min-w-0 gap-2 wrap-anywhere">
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">
            {entry.from === 'user' ? 'You' : 'Chat'} →{' '}
            <a className={textLink} href={target}>
              {run?.title ?? 'Worker'}
            </a>
          </strong>
          <Time at={entry.at} />
        </div>
        {entry.text && <Markdown text={entry.text} />}
      </li>
    )
  }
  const label = entry.kind === 'read' ? 'Result reviewed' : entry.kind === 'stopped' ? 'Worker stopped' : `Interrupted · ${entry.reason}`
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 wrap-anywhere text-xs text-muted-foreground">
      <a className={textLink} href={target}>
        {run?.title ?? 'Worker'}
      </a>
      <span>{label}</span>
      <Time at={entry.at} />
    </li>
  )
}

export function ChatWorkspace({
  id,
  live,
  now,
  offline,
  stop,
  attention,
}: {
  id: string
  live?: ChatSummary
  now: number
  offline: boolean
  stop: (chat: ChatSummary) => void
  attention?: ReactNode
}) {
  // Progress arrives in chat SSE snapshots; it must not refetch the timeline per token.
  const revision = live ? JSON.stringify({ ...live, liveOutput: undefined }) : undefined
  const detail = useDetail(id, api.chat, revision)
  const wide = useMediaQuery(WIDE)
  const chat = live ?? (detail.data && { ...detail.data.chat, runs: detail.data.runs })
  const entries = detail.data?.timeline
  const thread = useRef<HTMLDivElement>(null)
  const stickToLatest = useRef(true)
  useLayoutEffect(() => {
    const viewport = thread.current?.querySelector<HTMLDivElement>(viewportSelector)
    if (viewport && stickToLatest.current) viewport.scrollTop = viewport.scrollHeight
  }, [entries, chat?.status, chat?.waiting, chat?.error, chat?.liveOutput])

  if (!chat)
    return (
      <>
        <WorkspaceHeader title="Chat" />
        <div className={`${contentWidth} py-4`}>
          <LoadNotice loading={!detail.error} error={detail.error} retry={detail.refresh} />
        </div>
      </>
    )

  const external = chat.kind === 'external'
  // The agent leading a chat Grip runs; an external chat's leader lives in its MCP host.
  const leader = engineNames[chat.engine ?? 'claude']
  const canStop = !external && chat.status !== 'stopped'
  return (
    <>
      <WorkspaceHeader
        title={chat.title}
        engine={chat.engine ?? (chat.host === 'claude-code' ? 'claude' : undefined)}
        details={
          <>
            <ChatStatus chat={chat} />
            {chat.folder && (
              <span className="min-w-0 wrap-anywhere" title={chat.folder}>
                {folderName(chat.folder)}
              </span>
            )}
            {chat.model && <span className="min-w-0 wrap-anywhere">{chat.model}</span>}
          </>
        }
        actions={
          <>
            <span className="text-xs text-muted-foreground">
              {chat.runs.length} {chat.runs.length === 1 ? 'worker' : 'workers'}
            </span>
            {canStop && (
              <Button className={touchButton} variant="outline" size="sm" type="button" disabled={offline} onClick={() => stop(chat)}>
                Stop chat
              </Button>
            )}
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {attention && (
            <div className={`${contentWidth} max-h-[min(11rem,30dvh)] shrink-0 overflow-y-auto py-3 empty:hidden md:hidden`}>
              {attention}
            </div>
          )}
          <ScrollArea
            className={scrollFrame}
            ref={thread}
            onScrollCapture={event => {
              const viewport = event.target
              if (viewport instanceof HTMLElement && viewport.matches(viewportSelector)) {
                stickToLatest.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 72
              }
            }}
          >
            <div className={`${contentWidth} grid min-w-0 gap-4 py-4 sm:gap-6 sm:py-6`}>
              <LoadNotice loading={!entries && !detail.error} error={detail.error} retry={detail.refresh} />
              {entries &&
                (entries.length ? (
                  <ol className="grid min-w-0 gap-5 sm:gap-6" aria-label="Conversation">
                    {entries.map((entry, index) => (
                      <TimelineItem key={`${entry.at}-${entry.kind}-${index}`} entry={entry} runs={chat.runs} now={now} />
                    ))}
                  </ol>
                ) : (
                  <p className="py-4 text-sm wrap-anywhere text-muted-foreground">
                    {external ? 'No messages yet.' : `${leader} is ready in ${chat.folder ?? 'this folder'}. Send a message to start.`}
                  </p>
                ))}
              {chat.status === 'working' && chat.liveOutput && (
                <div className="min-w-0 wrap-anywhere" aria-label="Reply in progress">
                  <Markdown text={chat.liveOutput} />
                </div>
              )}
              {chat.status === 'working' && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                  <StatusDot status={chat.waiting ? 'waiting' : 'working'} engine={chat.engine ?? 'claude'} />
                  {chat.waiting ? `${leader} is waiting for its workers.` : `${leader} is working on its reply.`}
                </p>
              )}
              <ErrorBanner text={chat.error} />
            </div>
          </ScrollArea>
          {external ? (
            <footer className={composerFrame}>
              <p className={`${contentWidth} text-sm text-muted-foreground`}>Reply to this chat in {hostName(chat.host)}.</p>
            </footer>
          ) : (
            <Composer
              name={`Message ${leader}`}
              queued={chat.status === 'working'}
              blocked={offline}
              settings={
                <TurnSettings
                  engine={chat.engine ?? 'claude'}
                  model={chat.model}
                  effort={chat.effort}
                  disabled={offline}
                  save={settings => api.chatSettings(id, settings)}
                />
              }
              send={async text => {
                await api.messageChat(id, text)
                detail.refresh()
              }}
            />
          )}
        </div>
        {wide && (
          <DetailsColumn label="Chat details">
            <ChatDetails chat={chat} now={now} />
          </DetailsColumn>
        )}
      </div>
    </>
  )
}
