import { ArrowUpRight, ChevronRight, Plus, RefreshCw } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'

import { untilText, WINDOW_LABELS, type UsageWindow } from '../../../src/quota/usage.js'
import { api } from '../api.js'
import { pickQuotaWindows, QUOTA_WINDOWS } from '../quota.js'
import { chatHref, runHref } from '../state.js'
import type { AppState, QuotaSnapshot, Route, RunSummary } from '../types.js'
import { RowMenu } from './row-menu.js'
import { useStoredState } from '../browser.js'
import {
  chatMark,
  chatStatusText,
  EngineMark,
  engineNames,
  engines,
  ErrorBanner,
  focusRing,
  folderName,
  hostName,
  runActivity,
  runMark,
  touchButton,
  useAction,
} from './common.js'

const sectionLabel = 'text-xs font-medium text-muted-foreground'
const rowLink = `flex min-w-0 items-center gap-2 rounded-md px-2 py-2 hover:bg-accent aria-[current=page]:bg-accent ${focusRing}`

function ListSection({
  storageKey,
  label,
  count,
  initiallyOpen = true,
  attention = false,
  action,
  children,
}: {
  storageKey: string
  label: string
  count: number
  initiallyOpen?: boolean
  attention?: boolean
  action?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useStoredState(
    `grip:section:${storageKey}`,
    stored => (stored === null ? initiallyOpen : stored === 'open'),
    next => (next ? 'open' : 'closed'),
  )

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h2 className="min-w-0">
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={`group h-auto max-w-full justify-start gap-1.5 px-2 py-1 text-left whitespace-normal ${touchButton} ${sectionLabel} ${attention ? 'text-amber-700 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300' : ''}`}
            >
              <ChevronRight className="size-3.5 motion-safe:transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
              {label} ({count})
            </Button>
          </CollapsibleTrigger>
        </h2>
        {action}
      </div>
      <CollapsibleContent className="min-w-0 pt-1">{children}</CollapsibleContent>
    </Collapsible>
  )
}

function RowText({ title, detail, detailTitle }: { title: string; detail: string; detailTitle?: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="truncate text-sm font-medium" title={title}>
        {title}
      </span>
      <span className="truncate text-xs text-muted-foreground" title={detailTitle}>
        {detail}
      </span>
    </span>
  )
}

function WorkerLink({ run, selected, now, offline }: { run: RunSummary; selected: boolean; now: number; offline: boolean }) {
  const stops = run.status === 'running' ? ' and stops working' : ''
  const files = run.worktree
    ? 'An unchanged worktree is removed; one with work in it stays until you remove it under Worktrees.'
    : 'Files stay on disk.'
  return (
    <li className="min-w-0">
      <RowMenu
        noun="worker"
        title={run.title}
        deleteDescription={`${run.title} leaves your list${stops}. ${files}`}
        offline={offline}
        rename={async title => void (await api.renameRun(run.id, title))}
        remove={async () => {
          await api.deleteRun(run.id)
          if (selected) location.hash = ''
        }}
      >
        <a href={runHref(run.id)} aria-current={selected ? 'page' : undefined} className={`${rowLink} pr-12 md:pr-9`}>
          <EngineMark engine={run.engine} status={runMark(run)} statusLabel={runActivity(run, now)} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={run.title}>
            {run.title}
          </span>
          {run.unseen && (
            <span
              className="size-1.5 shrink-0 rounded-full bg-foreground"
              role="img"
              aria-label="Unviewed result"
              title="Unviewed result"
            />
          )}
        </a>
      </RowMenu>
    </li>
  )
}

export function NeedsAttention({
  state,
  now,
  proceed,
  retry,
  offline,
  chatId,
  compact = false,
}: {
  state: AppState
  now: number
  proceed: (run: RunSummary) => void
  retry: (run: RunSummary) => void
  offline: boolean
  chatId?: string
  compact?: boolean
}) {
  const runs = state.runs.filter(run => (run.status === 'failed' || run.status === 'stopped') && (!chatId || run.chatId === chatId))
  if (!runs.length) return null

  return (
    <ListSection
      storageKey={compact || chatId ? 'needs-you-workspace' : 'needs-you'}
      label="Needs you"
      count={runs.length}
      initiallyOpen={!compact}
      attention
    >
      <ul className="grid min-w-0 divide-y">
        {runs.map(run => {
          const owner = state.chats.find(chat => chat.id === run.chatId)
          return (
            <li key={run.id} className="grid min-w-0 gap-2 px-2 py-2">
              <div className="grid min-w-0 gap-1 text-xs wrap-anywhere text-muted-foreground">
                <a
                  href={runHref(run.id)}
                  className="flex min-w-0 items-baseline gap-2 text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline"
                >
                  <EngineMark engine={run.engine} />
                  {run.title}
                </a>
                <p>
                  {runActivity(run, now)} · {owner?.title ?? 'Independent worker'}
                </p>
                {run.error && <p className="text-destructive">{run.error}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button className={touchButton} type="button" variant="outline" size="sm" disabled={offline} onClick={() => proceed(run)}>
                  Continue
                </Button>
                <Button className={touchButton} type="button" variant="outline" size="sm" disabled={offline} onClick={() => retry(run)}>
                  Retry with another agent
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
    </ListSection>
  )
}

export function Navigation({
  state,
  active,
  now,
  offline,
  newChat,
  newWorker,
}: {
  state: AppState
  active: Route
  now: number
  offline: boolean
  newChat: () => void
  newWorker: () => void
}) {
  const independent = state.runs.filter(run => !run.chatId || !state.chats.some(chat => chat.id === run.chatId))
  return (
    <nav className="grid min-w-0 gap-3" aria-label="Chats and workers">
      <ListSection
        storageKey="chats"
        label="Chats"
        count={state.chats.length}
        action={
          <Button className={`shrink-0 ${touchButton}`} type="button" variant="ghost" size="sm" disabled={offline} onClick={newChat}>
            <Plus aria-hidden="true" />
            New chat
          </Button>
        }
      >
        {state.chats.length ? (
          <ul className="grid min-w-0 gap-1">
            {state.chats.map((chat, index) => {
              const selected = active.kind === 'chat' && active.id === chat.id
              const activeWorker = active.kind === 'run' && chat.runs.some(run => run.id === active.id)
              return (
                <li key={chat.id} className="min-w-0">
                  {index > 0 && <Separator className="mb-1" />}
                  <RowMenu
                    noun="chat"
                    title={chat.title}
                    deleteDescription={`${chat.title} and its ${chat.runs.length} workers leave your list. Files stay on disk.`}
                    offline={offline}
                    rename={async title => void (await api.renameChat(chat.id, title))}
                    remove={async () => {
                      await api.deleteChat(chat.id)
                      if (selected || activeWorker) location.hash = ''
                    }}
                  >
                    <a href={chatHref(chat.id)} className={`${rowLink} pr-12`} aria-current={selected ? 'page' : undefined}>
                      {chat.engine || chat.host === 'claude-code' ? (
                        <EngineMark engine={chat.engine ?? 'claude'} status={chatMark(chat)} statusLabel={chatStatusText(chat)} />
                      ) : (
                        <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      )}
                      <RowText
                        title={chat.title}
                        detail={folderName(chat.folder) || hostName(chat.host)}
                        detailTitle={chat.folder ?? undefined}
                      />
                    </a>
                  </RowMenu>
                  {chat.runs.length > 0 && (
                    <ul className="mt-1 ml-4 grid min-w-0 gap-0.5 border-l pl-2" aria-label={`Workers for ${chat.title}`}>
                      {chat.runs.map(run => (
                        <WorkerLink
                          key={run.id}
                          run={run}
                          now={now}
                          offline={offline}
                          selected={active.kind === 'run' && active.id === run.id}
                        />
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="px-2 py-1 text-xs text-muted-foreground">No chats yet.</p>
        )}
      </ListSection>
      <ListSection
        storageKey="independent-workers"
        label="Independent workers"
        count={independent.length}
        action={
          <Button
            className="size-11 shrink-0 md:size-8"
            type="button"
            variant="outline"
            size="icon"
            aria-label="Start one worker"
            title="Start one worker"
            disabled={offline}
            onClick={newWorker}
          >
            <Plus aria-hidden="true" />
          </Button>
        }
      >
        {independent.length ? (
          <ul className="grid min-w-0 gap-0.5">
            {independent.map(run => (
              <WorkerLink key={run.id} run={run} now={now} offline={offline} selected={active.kind === 'run' && active.id === run.id} />
            ))}
          </ul>
        ) : (
          <p className="px-2 py-1 text-xs text-muted-foreground">No independent workers.</p>
        )}
      </ListSection>
    </nav>
  )
}

function QuotaWindow({
  name,
  reading,
  now,
  provider,
}: {
  name: (typeof QUOTA_WINDOWS)[number]
  reading?: UsageWindow
  now: number
  provider: string
}) {
  const labels = WINDOW_LABELS[name]!
  const expired = reading?.resetsAt && Date.parse(reading.resetsAt) <= now
  const remaining = reading ? Math.max(0, Math.min(100, Math.round(100 - reading.usedPercent))) : undefined
  const reset = reading?.resetsAt ? untilText(reading.resetsAt, now) : ''
  return (
    <div className="grid min-w-0 content-start gap-1" title={reading?.stale || expired ? 'Stale reading' : undefined}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-1">
        <span className="text-muted-foreground">{labels.short}</span>
        <span className="font-medium whitespace-nowrap tabular-nums">{remaining === undefined ? '—' : `${remaining}% left`}</span>
      </div>
      <Progress
        className={`h-1 ${reading?.stale || expired ? 'opacity-50' : ''}`}
        value={remaining ?? 0}
        aria-hidden={remaining === undefined ? true : undefined}
        aria-label={`${provider} ${labels.long} quota remaining`}
        aria-valuenow={remaining}
        aria-valuetext={remaining === undefined ? undefined : `${remaining}% left`}
      />
      {reset && <p className="leading-tight text-muted-foreground">{reset === 'reset due' ? 'Reset due' : `Resets ${reset}`}</p>}
    </div>
  )
}

export function QuotaStrip({ snapshot, now, offline }: { snapshot: QuotaSnapshot; now: number; offline: boolean }) {
  const action = useAction()
  const busy = action.busy || snapshot.providers.some(provider => provider.busy)
  const refresh = () =>
    void action.perform(async () => {
      const refreshed = await api.refreshQuota()
      const errors = refreshed.providers.filter(provider => provider.error)
      if (errors.length) throw new Error(errors.map(provider => provider.error).join(' · '))
    })

  return (
    <section className="grid min-w-0 gap-2" aria-label="Quota">
      <div className="flex items-center justify-between">
        <h2 className={sectionLabel}>Quota</h2>
        <Button
          className="size-11 md:size-7"
          variant="ghost"
          size="icon"
          type="button"
          title="Refresh quota"
          aria-label="Refresh quota"
          disabled={offline || busy}
          onClick={refresh}
        >
          <RefreshCw className={busy ? 'motion-safe:animate-spin' : undefined} aria-hidden="true" />
        </Button>
      </div>
      <div className="grid min-w-0 grid-cols-3 gap-2 text-xs">
        {engines.map(engine => {
          const provider = snapshot.providers.find(item => item.provider === engine)
          const readings = pickQuotaWindows(provider?.windows)
          return (
            <div key={engine} className="row-span-3 grid min-w-0 grid-rows-subgrid" title={provider?.error ?? undefined}>
              <h3 className="flex min-w-0 items-center gap-1 font-medium">
                <EngineMark engine={engine} />
                <span className="truncate" title={engineNames[engine]}>
                  {engineNames[engine]}
                </span>
              </h3>
              {QUOTA_WINDOWS.map(name => (
                <QuotaWindow key={name} name={name} reading={readings[name]} now={now} provider={engineNames[engine]} />
              ))}
            </div>
          )
        })}
      </div>
      <ErrorBanner text={action.error} />
    </section>
  )
}
