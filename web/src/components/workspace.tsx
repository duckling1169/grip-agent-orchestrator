import { ArrowLeft, ArrowUpRight } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'

import { agoText, durationText, minutesBetween } from '../../../src/quota/usage.js'
import { api } from '../api.js'
import { chatHref, runHref, useDetail } from '../state.js'
import type { AppState, ChatSummary, Engine, RunDetail, RunSummary, TimelineEntry } from '../types.js'
import { EngineMark, ErrorBanner, folderName, isEngine, Markdown, runActivity, StatusDot, Time, useAction } from './common.js'
import { useModelChoices } from './dialogs.js'
import { ChatStatus, hostName } from './navigation.js'

const contentWidth = 'mx-auto w-full max-w-4xl px-4 sm:px-6 lg:px-8'
const composerFrame = 'shrink-0 border-t bg-background pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]'
// Keep Radix's intrinsic-width wrapper from expanding the viewport for code blocks and diffs.
const scrollFrame = 'min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!'
const viewportSelector = '[data-slot="scroll-area-viewport"]'
const pathText = 'font-mono text-xs wrap-anywhere'
const textLink = 'font-medium underline-offset-4 hover:underline focus-visible:underline'
const touchButton = 'min-h-11 md:min-h-8'

export function Composer({
  name,
  queued,
  blocked,
  focus,
  send,
  settings,
}: {
  name: string
  queued?: boolean
  blocked: boolean
  focus?: number
  send: (text: string) => Promise<void>
  /** Model and effort pickers for the next turn. */
  settings?: ReactNode
}) {
  const id = useId()
  const ref = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState('')
  const [notice, setNotice] = useState('')
  const action = useAction()
  useEffect(() => {
    if (focus !== undefined) ref.current?.focus()
  }, [focus])

  return (
    <form
      className={composerFrame}
      onSubmit={event => {
        event.preventDefault()
        const message = text.trim()
        if (!message || blocked) return
        setNotice('')
        void action.perform(async () => {
          await send(message)
          setText('')
          if (queued) setNotice('Message accepted for the next turn.')
          ref.current?.focus()
        })
      }}
    >
      <div className={`${contentWidth} grid gap-2`}>
        <label className="sr-only" htmlFor={id}>
          {name}
        </label>
        <Textarea
          className="max-h-40 resize-y overflow-y-auto"
          id={id}
          ref={ref}
          rows={2}
          value={text}
          disabled={blocked}
          readOnly={action.busy}
          onChange={event => {
            setText(event.currentTarget.value)
            setNotice('')
          }}
          placeholder={name}
        />
        <ErrorBanner text={action.error} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-0 flex-1 text-xs text-muted-foreground" role="status">
            {notice || (queued ? 'Messages queue while Claude is working.' : '')}
          </span>
          {settings}
          <Button className={`shrink-0 ${touchButton}`} size="sm" type="submit" disabled={!text.trim() || blocked || action.busy}>
            {action.busy ? 'Sending…' : 'Send message'}
          </Button>
        </div>
      </div>
    </form>
  )
}

/** The model and effort the next turn uses, saved as soon as they change. */
function TurnSettings({
  engine,
  model,
  effort,
  disabled,
  save,
}: {
  engine: Engine
  model: string | null
  effort: string | null
  disabled: boolean
  save: (settings: { model: string | null; effort: string | null }) => Promise<unknown>
}) {
  const action = useAction()
  const choices = useModelChoices(engine, model ?? '', effort ?? '')
  const choose = (next: { model: string; effort: string }) =>
    void action.perform(async () => {
      await save({ model: next.model || null, effort: next.effort || null })
    })
  const modelName = model ? (choices.chosen?.label ?? model) : 'Default model'
  const effortName = effort || (choices.defaultEffort ? `${choices.defaultEffort} effort` : 'Default effort')
  const off = disabled || action.busy || choices.loading
  // Small text like Claude Code's footer; each opens a menu.
  const link = 'h-8 gap-1 px-1.5 text-xs font-normal text-muted-foreground hover:text-foreground md:h-7'
  return (
    <span className="flex shrink-0 items-center" title={action.error || choices.error || undefined}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className={link} disabled={off} aria-label={`Model: ${modelName}`}>
            {modelName}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80">
          <DropdownMenuLabel>Model for the next message</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={model ?? ''} onValueChange={value => choose(choices.pickModel(value))}>
            <DropdownMenuRadioItem value="">Agent default</DropdownMenuRadioItem>
            {choices.models.map(option => (
              <DropdownMenuRadioItem key={option.id} value={option.id}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
            {model && !choices.chosen && <DropdownMenuRadioItem value={model}>{model}</DropdownMenuRadioItem>}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {choices.efforts.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={`${link} capitalize`}
              disabled={off}
              aria-label={`Effort: ${effortName}`}
            >
              {effortName}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Effort</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={effort ?? ''} onValueChange={value => choose({ model: model ?? '', effort: value })}>
              <DropdownMenuRadioItem value="">Default{choices.defaultEffort ? ` (${choices.defaultEffort})` : ''}</DropdownMenuRadioItem>
              {choices.efforts.map(option => (
                <DropdownMenuRadioItem key={option} value={option} className="capitalize">
                  {option}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {action.error && (
        <span className="sr-only" role="alert">
          {action.error}
        </span>
      )}
    </span>
  )
}

function LoadNotice({ loading, error, retry }: { loading: boolean; error?: string; retry: () => void }) {
  if (!error && !loading) return null
  return (
    <div className="grid justify-items-start gap-2 text-sm text-muted-foreground">
      <ErrorBanner text={error} />
      {error ? (
        <Button className={touchButton} variant="outline" size="sm" type="button" onClick={retry}>
          Try again
        </Button>
      ) : (
        <p role="status">Loading…</p>
      )}
    </div>
  )
}

function WorkspaceHeader({
  backHref = '#/',
  backLabel = 'Chats',
  title,
  engine,
  details,
  actions,
}: {
  backHref?: string
  backLabel?: string
  title: string
  engine?: Engine
  details?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3 sm:px-6 lg:px-8">
      <div className="w-full md:hidden">
        <Button variant="ghost" size="sm" className={`-ml-2 ${touchButton}`} asChild>
          <a href={backHref}>
            <ArrowLeft aria-hidden="true" />
            {backLabel}
          </a>
        </Button>
      </div>
      <div className="min-w-0 flex-[1_1_12rem]">
        <h1 className="flex items-baseline gap-2 text-lg font-semibold tracking-tight sm:text-xl">
          {engine && <EngineMark engine={engine} />}
          <span className="min-w-0 wrap-anywhere">{title}</span>
        </h1>
        {details && <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">{details}</div>}
      </div>
      {actions && <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">{actions}</div>}
    </header>
  )
}

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
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-4 pt-4 pb-2 transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
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
    const from = entry.kind === 'reply' ? 'Claude' : entry.from === 'grip' ? 'Grip' : 'You'
    const user = entry.kind === 'message' && entry.from === 'user'
    return (
      <li
        className={`grid min-w-0 gap-2 wrap-anywhere ${user ? 'ml-auto max-w-[92%] rounded-xl rounded-br-sm border bg-muted/50 px-4 py-3' : ''}`}
      >
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">{from}</strong>
          <Time at={entry.at} />
        </div>
        {entry.text && <Markdown text={entry.text} />}
        {entry.kind === 'reply' && <ErrorBanner text={entry.error} />}
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
  const detail = useDetail(id, api.chat, live)
  const chat = live ?? (detail.data && { ...detail.data.chat, runs: detail.data.runs })
  const entries = detail.data?.timeline
  const thread = useRef<HTMLDivElement>(null)
  const stickToLatest = useRef(true)
  useLayoutEffect(() => {
    const viewport = thread.current?.querySelector<HTMLDivElement>(viewportSelector)
    if (viewport && stickToLatest.current) viewport.scrollTop = viewport.scrollHeight
  }, [entries, chat?.status, chat?.waiting, chat?.error])

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
      {attention && (
        <div className={`${contentWidth} max-h-[min(11rem,30dvh)] shrink-0 overflow-y-auto py-3 empty:hidden md:hidden`}>{attention}</div>
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
                {external ? 'No messages yet.' : `Claude is ready in ${chat.folder ?? 'this folder'}. Send a message to start.`}
              </p>
            ))}
          {chat.status === 'working' && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <StatusDot status={chat.waiting ? 'waiting' : 'working'} engine={chat.engine} />
              {chat.waiting ? 'Claude is waiting for its workers.' : 'Claude is working on its reply.'}
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
          name="Message Claude"
          queued={chat.status === 'working'}
          blocked={offline}
          settings={
            <TurnSettings
              engine="claude"
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
    </>
  )
}

function WorkerSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid min-w-0 gap-3 border-b pb-5 wrap-anywhere last:border-b-0 last:pb-0">
      <h2 className="font-medium">{title}</h2>
      {children}
    </section>
  )
}

function Facts({ children }: { children: ReactNode }) {
  return <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 text-sm wrap-anywhere sm:gap-x-6">{children}</dl>
}

function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="mb-0.5 text-xs text-muted-foreground">{name}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function Diff({ diff }: { diff: NonNullable<RunDetail['diff']> }) {
  const sections = diff.patch.split(/(?=^diff --git )/m).filter(Boolean)
  return (
    <WorkerSection title="Diff">
      {diff.stat && <pre className="min-w-0 overflow-x-auto rounded-md border bg-muted/50 p-3 text-xs">{diff.stat}</pre>}
      {sections.map((section, index) => {
        const file = section.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? section.match(/^--- a\/(.+)$/m)?.[1] ?? section.split('\n')[0] ?? 'Patch'
        return (
          <details className="min-w-0 overflow-hidden rounded-md border" key={`${file}-${index}`}>
            <summary className="cursor-pointer px-3 py-2 font-mono text-xs wrap-anywhere hover:bg-muted focus-visible:bg-muted">
              {file}
            </summary>
            <pre className="overflow-x-auto border-t bg-muted/30 py-2 text-xs leading-relaxed">
              {section.split('\n').map((line, row) => {
                const tone =
                  line.startsWith('+') && !line.startsWith('+++')
                    ? 'bg-muted font-medium'
                    : line.startsWith('-') && !line.startsWith('---')
                      ? 'bg-destructive/10 text-destructive'
                      : ''
                return (
                  <span key={row} className={tone}>
                    {line}
                    {'\n'}
                  </span>
                )
              })}
            </pre>
          </details>
        )
      })}
      {diff.untrackedFiles.length > 0 && <p className="text-sm text-muted-foreground">Untracked: {diff.untrackedFiles.join(', ')}</p>}
      {diff.truncated && <p className="text-sm text-muted-foreground">Grip shortened this patch.</p>}
      {!sections.length && !diff.untrackedFiles.length && <p className="text-sm text-muted-foreground">No changes.</p>}
    </WorkerSection>
  )
}

function RunOutput({ run, now }: { run: RunDetail; now: number }) {
  return (
    <>
      <WorkerSection title="Brief">
        {'path' in run.brief ? <code className={pathText}>{run.brief.path}</code> : <Markdown text={run.brief.text} />}
      </WorkerSection>
      <WorkerSection title="Turns">
        {run.turns.length ? (
          <ol className="grid min-w-0 divide-y">
            {run.turns.map(turn => (
              <li key={turn.turn} className="grid min-w-0 gap-3 py-4 first:pt-0 last:pb-0">
                <h3 className="text-sm font-medium">
                  Turn {turn.turn}{' '}
                  <span className="font-normal text-muted-foreground">
                    · {turn.from === 'user' ? 'You' : turn.turn === 1 ? 'Original brief' : 'Orchestrator'}
                  </span>
                </h3>
                {turn.message && (
                  <div className="min-w-0 rounded-md bg-muted/50 p-3">
                    <Markdown text={turn.message} />
                  </div>
                )}
                {turn.output ? <Markdown text={turn.output} /> : <p className="text-sm text-muted-foreground">No output recorded.</p>}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">No turns recorded yet.</p>
        )}
      </WorkerSection>
      {run.overlaps.length > 0 && (
        <WorkerSection title="Overlapping changes">
          <ul className="grid gap-2 text-sm text-muted-foreground">
            {run.overlaps.map(overlap => (
              <li key={overlap.runId}>
                <a className={textLink} href={runHref(overlap.runId)}>
                  {overlap.title}
                </a>{' '}
                · {overlap.files.join(', ')}
              </li>
            ))}
          </ul>
        </WorkerSection>
      )}
      {run.git && (
        <WorkerSection title="Git">
          <Facts>
            <Fact name="Commits ahead">{run.git.ahead}</Fact>
            <Fact name="Files changed">{run.git.changedFiles.length}</Fact>
            {run.git.lastCommit && (
              <Fact name="Last commit">
                {run.git.lastCommit.subject} · {agoText(run.git.lastCommit.at, now)}
              </Fact>
            )}
            {run.git.newestEdit && (
              <Fact name="Last edit">
                {run.git.newestEdit.file} · {agoText(run.git.newestEdit.at, now)}
              </Fact>
            )}
          </Facts>
          {run.git.changedFiles.length > 0 && (
            <ul className="grid gap-1">
              {run.git.changedFiles.map(file => (
                <li key={file}>
                  <code className={pathText}>{file}</code>
                </li>
              ))}
            </ul>
          )}
        </WorkerSection>
      )}
      {run.diff && <Diff diff={run.diff} />}
    </>
  )
}

export function RunWorkspace({
  id,
  live,
  state,
  now,
  offline,
  focus,
  stop,
  retry,
}: {
  id: string
  live?: RunSummary
  state: AppState | null
  now: number
  offline: boolean
  focus?: number
  stop: (run: RunSummary) => void
  retry: (run: RunSummary) => void
}) {
  const detail = useDetail(id, api.run, live)
  const copy = useAction()
  const [copied, setCopied] = useState(false)
  const run = live ?? (detail.data && { ...detail.data, turns: detail.data.turns.length })
  if (!run)
    return (
      <>
        <WorkspaceHeader title="Worker" />
        <div className={`${contentWidth} py-4`}>
          <LoadNotice loading={!detail.error} error={detail.error} retry={detail.refresh} />
        </div>
      </>
    )

  const owner = state?.chats.find(chat => chat.id === run.chatId)
  const back = run.chatId ? chatHref(run.chatId) : '#/'
  const active = run.status === 'running'
  const ended = run.finishedAt ? Date.parse(run.finishedAt) : now
  const elapsed = durationText(minutesBetween(run.createdAt, ended) ?? 0)
  return (
    <>
      <WorkspaceHeader
        backHref={back}
        backLabel={run.chatId ? 'Chat' : 'Chats'}
        title={run.title}
        engine={run.engine}
        details={
          <>
            <span className="inline-flex items-center gap-1.5">
              <StatusDot status={run.status} engine={run.engine} />
              {runActivity(run, now)}
            </span>
            <span className="min-w-0 wrap-anywhere" title={run.worktree ?? run.folder}>
              {folderName(run.worktree ?? run.folder)}
            </span>
          </>
        }
        actions={
          <>
            <Button
              className={touchButton}
              variant="outline"
              size="sm"
              type="button"
              disabled={copy.busy}
              onClick={() =>
                void copy.perform(async () => {
                  await navigator.clipboard.writeText(run.worktree ?? run.folder)
                  setCopied(true)
                })
              }
            >
              {copied ? 'Path copied' : 'Copy folder path'}
            </Button>
            {active ? (
              <Button className={touchButton} variant="outline" size="sm" type="button" disabled={offline} onClick={() => stop(run)}>
                Stop worker
              </Button>
            ) : (
              <Button className={touchButton} variant="outline" size="sm" type="button" disabled={offline} onClick={() => retry(run)}>
                Retry with another agent
              </Button>
            )}
          </>
        }
      />
      <ScrollArea className={scrollFrame}>
        <div className={`${contentWidth} grid min-w-0 gap-5 pt-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:pt-6`}>
          <ErrorBanner text={run.error} />
          <ErrorBanner text={copy.error} />
          <WorkerSection title="Worker details">
            <Facts>
              <Fact name="Agent">
                <EngineMark engine={run.engine} labelled />
                {run.model && ` · ${run.model}`}
              </Fact>
              {detail.data?.effort && <Fact name="Effort">{detail.data.effort}</Fact>}
              <Fact name="Chat">
                {run.chatId ? (
                  <a className={textLink} href={back}>
                    {owner?.title ?? 'Chat'}
                  </a>
                ) : (
                  'Independent worker'
                )}
              </Fact>
              <Fact name="Started">
                <time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString()}</time>
              </Fact>
              <Fact name="Elapsed">{elapsed}</Fact>
              <Fact name="Turns started">{run.turns}</Fact>
              <Fact name="Folder">
                <code className={pathText}>{run.folder}</code>
              </Fact>
              {run.worktree && (
                <Fact name="Worktree">
                  <code className={pathText}>{run.worktree}</code>
                </Fact>
              )}
              {run.branch && (
                <Fact name="Branch">
                  <code className={pathText}>{run.branch}</code>
                </Fact>
              )}
            </Facts>
          </WorkerSection>
          <LoadNotice loading={!detail.data && !detail.error} error={detail.error} retry={detail.refresh} />
          {detail.data && <RunOutput run={detail.data} now={now} />}
        </div>
      </ScrollArea>
      {!active && (
        <Composer
          name="Message worker"
          blocked={offline}
          settings={
            <TurnSettings
              engine={run.engine}
              model={run.model}
              effort={run.effort ?? null}
              disabled={offline}
              save={settings => api.runSettings(id, settings)}
            />
          }
          focus={focus}
          send={async text => {
            await api.messageRun(id, text)
            detail.refresh()
          }}
        />
      )}
    </>
  )
}
