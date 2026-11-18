import { useState } from 'preact/hooks'

import { untilText, verdict, WINDOW_LABELS, windowLevel } from '../../../src/quota/usage.js'
import { api } from '../api.js'
import { chatHref, runHref } from '../state.js'
import type { AppState, QuotaSnapshot, Route, RunSummary } from '../types.js'
import { EngineMark, ErrorBanner, engines, folderName, runActivity, StatusDot, useAction } from './common.js'

export function hostName(host: string | null) {
  return host === 'claude-code' ? 'Claude Code' : host || 'its MCP host'
}

export function ChatStatus({ chat }: { chat: AppState['chats'][number] }) {
  const label = chat.waiting
    ? 'Waiting on workers'
    : chat.kind === 'external'
      ? hostName(chat.host)
      : { working: 'Working', idle: 'Ready', failed: 'Failed', stopped: 'Stopped' }[chat.status]
  return (
    <span class="chat-status">
      <StatusDot status={chat.waiting ? 'waiting' : chat.status} engine={chat.engine} />
      {label}
    </span>
  )
}

function WorkerLink({ run, selected, now }: { run: RunSummary; selected: boolean; now: number }) {
  return (
    <li class="worker-item">
      <a href={runHref(run.id)} aria-current={selected ? 'page' : undefined} class={selected ? 'is-selected' : undefined}>
        <EngineMark engine={run.engine} />
        <span class="worker-link-text">
          <span class="worker-link-title" title={run.title}>
            {run.title}
          </span>
          <small class="muted">{runActivity(run, now, true)}</small>
        </span>
        {run.unseen ? (
          <span class="unseen-dot" aria-label="Unviewed result" title="Unviewed result" />
        ) : (
          run.status === 'running' && <StatusDot status={run.status} engine={run.engine} />
        )}
      </a>
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
  const items = (
    <ul>
      {runs.map(run => {
        const owner = state.chats.find(chat => chat.id === run.chatId)
        return (
          <li key={run.id} class="attention-item">
            <div class="attention-copy">
              <a href={runHref(run.id)}>
                <EngineMark engine={run.engine} /> {run.title}
              </a>
              <small class="muted">
                {runActivity(run, now)} · {owner?.title ?? 'Independent worker'}
              </small>
              {run.error && <small>{run.error}</small>}
            </div>
            <div class="attention-actions">
              <button type="button" class="button button-secondary" disabled={offline} onClick={() => proceed(run)}>
                Continue
              </button>
              <button type="button" class="button button-secondary" disabled={offline} onClick={() => retry(run)}>
                Retry with another agent
              </button>
            </div>
          </li>
        )
      })}
    </ul>
  )
  if (compact)
    return (
      <details class="needs-attention attention-compact">
        <summary>{runs.length === 1 ? '1 worker needs you' : `${runs.length} workers need you`}</summary>
        {items}
      </details>
    )
  return (
    <section class="needs-attention" aria-label="Needs you">
      <div class="section-heading">
        <h2>Needs you</h2>
        <span class="badge">{runs.length}</span>
      </div>
      {items}
    </section>
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
    <>
      <div class="sidebar-header">
        <div class="section-heading">
          <h2>Chats</h2>
          <button type="button" class="button button-primary" disabled={offline} onClick={newChat}>
            + New chat
          </button>
        </div>
      </div>
      <nav class="chat-list" aria-label="Chats and workers">
        {!state.chats.length && <p class="sidebar-empty muted">No chats yet.</p>}
        <ul class="chat-items">
          {state.chats.map(chat => {
            const selected = active.kind === 'chat' && active.id === chat.id
            const activeWorker = active.kind === 'run' && chat.runs.some(run => run.id === active.id)
            return (
              <li key={chat.id} class={`chat-item${activeWorker ? ' has-active-worker' : ''}`}>
                <a
                  href={chatHref(chat.id)}
                  class={`chat-button${selected ? ' is-selected' : ''}`}
                  aria-current={selected ? 'page' : undefined}
                >
                  {chat.engine || chat.host === 'claude-code' ? (
                    <EngineMark engine={chat.engine ?? 'claude'} />
                  ) : (
                    <span class="external-mark" aria-hidden="true">
                      ↗
                    </span>
                  )}
                  <span class="chat-link-text">
                    <span class="chat-link-title" title={chat.title}>
                      {chat.title}
                    </span>
                    <small class="muted" title={chat.folder ?? undefined}>
                      {folderName(chat.folder) || hostName(chat.host)}
                    </small>
                  </span>
                  {(chat.status === 'working' || chat.waiting) && (
                    <StatusDot status={chat.waiting ? 'waiting' : 'working'} engine={chat.engine} />
                  )}
                </a>
                {chat.runs.length > 0 && (
                  <ul class="worker-list" aria-label={`Workers for ${chat.title}`}>
                    {chat.runs.map(run => (
                      <WorkerLink key={run.id} run={run} now={now} selected={active.kind === 'run' && active.id === run.id} />
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
        <div class="independent-workers">
          <div class="section-heading">
            <h2>Independent workers</h2>
            <button
              type="button"
              class="icon-button"
              aria-label="Start one worker"
              title="Start one worker"
              disabled={offline}
              onClick={newWorker}
            >
              +
            </button>
          </div>
          {independent.length ? (
            <ul class="worker-list">
              {independent.map(run => (
                <WorkerLink key={run.id} run={run} now={now} selected={active.kind === 'run' && active.id === run.id} />
              ))}
            </ul>
          ) : (
            <p class="sidebar-empty muted">No independent workers.</p>
          )}
        </div>
      </nav>
    </>
  )
}

export function QuotaStrip({ snapshot, now, offline }: { snapshot: QuotaSnapshot; now: number; offline: boolean }) {
  const action = useAction()
  const [showRead, setShowRead] = useState(false)
  const providers = snapshot.providers.map(provider => ({
    ...provider,
    windows: provider.windows.map(window =>
      window.resetsAt && Date.parse(window.resetsAt) <= now ? { ...window, usedPercent: 0, stale: true } : window,
    ),
  }))
  const refresh = (claude: boolean) =>
    void action.perform(async () => {
      const refreshed = await api.refreshQuota(claude)
      const errors = refreshed.providers.filter(
        provider => (claude ? provider.provider === 'claude' : provider.provider !== 'claude') && provider.error,
      )
      if (errors.length) throw new Error(errors.map(provider => provider.error).join(' · '))
      setShowRead(false)
    })
  const assessment = verdict(providers, now)
  return (
    <section class="quota-strip" aria-label="Quota">
      <div class="section-heading">
        <h2>Quota</h2>
        <button
          type="button"
          class="icon-button"
          title="Refresh Codex and Antigravity quotas"
          aria-label="Refresh free quota readings"
          disabled={offline || action.busy || providers.some(provider => provider.busy)}
          onClick={() => refresh(false)}
        >
          ↻
        </button>
      </div>
      {engines.map(engine => {
        const provider = providers.find(item => item.provider === engine)
        const tightest = provider?.windows.reduce<(typeof provider.windows)[number] | undefined>((tight, window) => {
          if (!tight || (tight.stale && !window.stale) || (tight.stale === window.stale && window.usedPercent > tight.usedPercent))
            return window
          return tight
        }, undefined)
        const left = tightest ? Math.max(0, Math.min(100, Math.round(100 - tightest.usedPercent))) : null
        const reset = tightest?.resetsAt ? untilText(tightest.resetsAt, now) : ''
        const details = [
          tightest ? (WINDOW_LABELS[tightest.name]?.short ?? tightest.name) : null,
          provider?.busy
            ? 'Reading…'
            : tightest?.stale
              ? 'Stale reading'
              : reset
                ? reset === 'reset due'
                  ? 'Reset due'
                  : `Resets ${reset}`
                : null,
          provider?.error ? 'Read failed' : null,
        ]
          .filter(Boolean)
          .join(' · ')
        return (
          <div class={`quota-provider engine-${engine}`} key={engine} title={provider?.error ?? undefined}>
            <div class="quota-provider-header">
              <EngineMark engine={engine} labelled />
              <span>{left === null ? '—' : `${left}% left`}</span>
            </div>
            <div class={`quota-track${tightest?.stale ? ' is-stale' : ''}`} aria-hidden="true">
              <span class={`quota-fill quota-${windowLevel(left ?? 100)}`} style={{ width: `${left ?? 0}%` }} />
            </div>
            <small class="muted">{details || 'No reading yet'}</small>
          </div>
        )
      })}
      <p class={`quota-verdict quota-${assessment.tone}`}>{assessment.text}</p>
      <ErrorBanner text={action.error} />
      {showRead ? (
        <div class="quota-confirm">
          <p>Reading Claude quota uses one small Claude turn.</p>
          <button type="button" class="button button-secondary" disabled={action.busy} onClick={() => setShowRead(false)}>
            Cancel
          </button>
          <button type="button" class="button button-secondary" disabled={offline || action.busy} onClick={() => refresh(true)}>
            Read Claude quota
          </button>
        </div>
      ) : (
        <button
          type="button"
          class="quiet-button"
          disabled={offline || action.busy || Boolean(providers.find(p => p.provider === 'claude')?.busy)}
          onClick={() => setShowRead(true)}
        >
          Read Claude quota…
        </button>
      )}
    </section>
  )
}
