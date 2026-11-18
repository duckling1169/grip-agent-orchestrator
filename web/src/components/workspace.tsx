import type { ComponentChildren } from 'preact'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks'

import { agoText, durationText, minutesBetween } from '../../../src/quota/usage.js'
import { api } from '../api.js'
import { chatHref, runHref, useDetail } from '../state.js'
import type { AppState, ChatSummary, RunDetail, RunSummary, TimelineEntry } from '../types.js'
import { EngineMark, ErrorBanner, folderName, isEngine, Markdown, runActivity, StatusDot, Time, useAction } from './common.js'
import { ChatStatus, hostName } from './navigation.js'

export function Composer({
  name,
  queued,
  blocked,
  focus,
  send,
}: {
  name: string
  queued?: boolean
  blocked: boolean
  focus?: number
  send: (text: string) => Promise<void>
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
      class="composer"
      onSubmit={event => {
        event.preventDefault()
        if (!text.trim() || blocked) return
        setNotice('')
        void action.perform(async () => {
          await send(text.trim())
          setText('')
          if (queued) setNotice('Message accepted for the next turn.')
          ref.current?.focus()
        })
      }}
    >
      <div class="composer-inner">
        <label class="visually-hidden" for={id}>
          {name}
        </label>
        <textarea
          class="composer-field"
          id={id}
          ref={ref}
          rows={2}
          value={text}
          disabled={blocked || action.busy}
          onInput={event => {
            setText(event.currentTarget.value)
            setNotice('')
          }}
          placeholder={name}
        />
        <ErrorBanner text={action.error} />
        <div class="composer-footer">
          <span class="muted" role={notice ? 'status' : undefined}>
            {notice || (queued ? 'Messages queue while Claude is working.' : '')}
          </span>
          <button class="button button-primary" type="submit" disabled={!text.trim() || blocked || action.busy}>
            {action.busy ? 'Sending…' : 'Send message'}
          </button>
        </div>
      </div>
    </form>
  )
}

function LoadNotice({ loading, error, retry }: { loading: boolean; error?: string; retry: () => void }) {
  if (!error && !loading) return null
  return (
    <div class="workspace-status">
      <ErrorBanner text={error} />
      {error ? (
        <button class="button button-secondary" type="button" onClick={retry}>
          Try again
        </button>
      ) : (
        <p role="status">Loading…</p>
      )}
    </div>
  )
}

function TimelineItem({ entry, runs, now }: { entry: TimelineEntry; runs: RunSummary[]; now: number }) {
  if (entry.kind === 'message' || entry.kind === 'reply') {
    const from = entry.kind === 'reply' ? 'Claude' : entry.from === 'grip' ? 'Grip' : 'You'
    const user = entry.kind === 'message' && entry.from === 'user'
    return (
      <li class={`timeline-entry message ${user ? 'user-message' : 'assistant-message'}`}>
        <div class="message-meta">
          <strong>{from}</strong>
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
      <li class={`timeline-entry worker-card${isEngine(entry.engine) ? ` engine-${entry.engine}` : ''}`}>
        <a href={target} class="worker-card-header">
          {isEngine(entry.engine) && <EngineMark engine={entry.engine} />}
          <strong>{entry.title}</strong>
          <span class="worker-card-state">
            {run && (
              <>
                <StatusDot status={run.status} engine={run.engine} />
                {runActivity(run, now, true)}
              </>
            )}
          </span>
          <span class="card-arrow" aria-hidden="true">
            ↗
          </span>
        </a>
        <div class="worker-card-meta">
          <span>Delegated</span>
          <Time at={entry.at} />
          {run?.branch && <code title={run.branch}>{run.branch}</code>}
        </div>
        <p class="worker-card-brief">{entry.brief}</p>
      </li>
    )
  }
  if (entry.kind === 'worker-result') {
    return (
      <li class={`timeline-entry worker-card worker-card-result${run ? ` engine-${run.engine}` : ''}`}>
        <a class="worker-card-header" href={target}>
          {run && <EngineMark engine={run.engine} />}
          <strong>{run?.title ?? 'Worker'}</strong>
          <span class="worker-card-state">
            <StatusDot status={entry.status} engine={run?.engine} />
            {entry.status === 'done' ? 'Done' : 'Failed'}
          </span>
          <span class="card-arrow" aria-hidden="true">
            ↗
          </span>
        </a>
        <div class="worker-card-meta">
          <span>Worker result</span>
          <Time at={entry.at} />
        </div>
        {entry.preview && <Markdown text={entry.preview} />}
        <ErrorBanner text={entry.error} />
      </li>
    )
  }
  if (entry.kind === 'to-worker') {
    return (
      <li class="timeline-entry message worker-message">
        <div class="message-meta">
          <strong>
            {entry.from === 'user' ? 'You' : 'Chat'} → <a href={target}>{run?.title ?? 'Worker'}</a>
          </strong>
          <Time at={entry.at} />
        </div>
        {entry.text && <Markdown text={entry.text} />}
      </li>
    )
  }
  const label = entry.kind === 'read' ? 'Result reviewed' : entry.kind === 'stopped' ? 'Worker stopped' : `Interrupted · ${entry.reason}`
  return (
    <li class="timeline-entry timeline-note">
      <a href={target}>{run?.title ?? 'Worker'}</a>
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
  attention?: ComponentChildren
}) {
  const detail = useDetail(id, api.chat, live)
  const chat = live ?? (detail.data && { ...detail.data.chat, runs: detail.data.runs })
  const entries = detail.data?.timeline
  const thread = useRef<HTMLDivElement>(null)
  const stickToLatest = useRef(true)
  useLayoutEffect(() => {
    const panel = thread.current
    if (panel && stickToLatest.current) panel.scrollTop = panel.scrollHeight
  }, [entries?.length, chat?.status, chat?.waiting])

  if (!chat)
    return (
      <>
        <header class="view-header">
          <a class="back-link mobile-back" href="#/">
            ← Chats
          </a>
          <h1>Chat</h1>
        </header>
        <LoadNotice loading={!detail.error} error={detail.error} retry={detail.refresh} />
      </>
    )
  const external = chat.kind === 'external'
  const canStop = !external && chat.status !== 'stopped'
  return (
    <>
      <header class="view-header">
        <a class="back-link mobile-back" href="#/">
          ← Chats
        </a>
        <div class="view-heading">
          <div class="view-title">
            {(chat.engine || chat.host === 'claude-code') && <EngineMark engine={chat.engine ?? 'claude'} />}
            <h1>{chat.title}</h1>
          </div>
          <div class="view-meta">
            <ChatStatus chat={chat} />
            {chat.folder && (
              <span class="view-folder" title={chat.folder}>
                {folderName(chat.folder)}
              </span>
            )}
            {chat.model && <span>{chat.model}</span>}
          </div>
        </div>
        <div class="view-actions">
          <span class="muted worker-count">
            {chat.runs.length} {chat.runs.length === 1 ? 'worker' : 'workers'}
          </span>
          {canStop && (
            <button class="button button-secondary" type="button" disabled={offline} onClick={() => stop(chat)}>
              Stop chat
            </button>
          )}
        </div>
      </header>
      <div class="mobile-attention chat-attention">{attention}</div>
      <div
        class="thread"
        ref={thread}
        onScroll={event => {
          const panel = event.currentTarget
          stickToLatest.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 72
        }}
      >
        <div class="thread-inner">
          <LoadNotice loading={!entries && !detail.error} error={detail.error} retry={detail.refresh} />
          {entries &&
            (entries.length ? (
              <ol class="timeline" aria-label="Conversation">
                {entries.map((entry, index) => (
                  <TimelineItem key={`${entry.at}-${entry.kind}-${index}`} entry={entry} runs={chat.runs} now={now} />
                ))}
              </ol>
            ) : (
              <div class="empty-thread">
                <p class="muted">No messages yet.</p>
              </div>
            ))}
          {chat.status === 'working' && (
            <p class="workspace-status working-note" role="status">
              <StatusDot status={chat.waiting ? 'waiting' : 'working'} engine={chat.engine} />
              {chat.waiting ? 'Claude is waiting for its workers.' : 'Claude is working on its reply.'}
            </p>
          )}
          <ErrorBanner text={chat.error} />
        </div>
      </div>
      {external ? (
        <footer class="composer external-note">
          <div class="composer-inner">Reply to this chat in {hostName(chat.host)}.</div>
        </footer>
      ) : (
        <Composer
          name="Message Claude"
          queued={chat.status === 'working'}
          blocked={offline}
          send={async text => {
            await api.messageChat(id, text)
            detail.refresh()
          }}
        />
      )}
    </>
  )
}

function Diff({ diff }: { diff: NonNullable<RunDetail['diff']> }) {
  const sections = diff.patch.split(/(?=^diff --git )/m).filter(Boolean)
  return (
    <section class="run-section">
      <h2>Diff</h2>
      {diff.stat && <pre class="code-block">{diff.stat}</pre>}
      {sections.map((section, index) => {
        const file = section.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? section.match(/^--- a\/(.+)$/m)?.[1] ?? section.split('\n')[0] ?? 'Patch'
        return (
          <details class="diff-file" key={`${file}-${index}`}>
            <summary>{file}</summary>
            <pre class="code-block diff-lines">
              {section.split('\n').map((line, row) => {
                const tone =
                  line.startsWith('+') && !line.startsWith('+++')
                    ? 'diff-add'
                    : line.startsWith('-') && !line.startsWith('---')
                      ? 'diff-remove'
                      : ''
                return (
                  <span key={row} class={tone}>
                    {line}
                    {'\n'}
                  </span>
                )
              })}
            </pre>
          </details>
        )
      })}
      {diff.untrackedFiles.length > 0 && <p class="muted">Untracked: {diff.untrackedFiles.join(', ')}</p>}
      {diff.truncated && <p class="muted">Grip shortened this patch.</p>}
      {!sections.length && !diff.untrackedFiles.length && <p class="muted">No changes.</p>}
    </section>
  )
}

function RunOutput({ run, now }: { run: RunDetail; now: number }) {
  return (
    <>
      <section class="run-section">
        <h2>Brief</h2>
        {'path' in run.brief ? <code class="path-label">{run.brief.path}</code> : <Markdown text={run.brief.text} />}
      </section>
      <section class="run-section">
        <h2>Turns</h2>
        {run.turns.length ? (
          <ol class="turn-list">
            {run.turns.map(turn => (
              <li key={turn.turn} class="turn">
                <h3>
                  Turn {turn.turn}{' '}
                  <span class="muted">· {turn.from === 'user' ? 'You' : turn.turn === 1 ? 'Original brief' : 'Orchestrator'}</span>
                </h3>
                {turn.message && (
                  <div class="turn-message">
                    <Markdown text={turn.message} />
                  </div>
                )}
                {turn.output ? (
                  <div class="turn-output">
                    <Markdown text={turn.output} />
                  </div>
                ) : (
                  <p class="muted">No output recorded.</p>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p class="muted">No turns recorded yet.</p>
        )}
      </section>
      {run.overlaps.length > 0 && (
        <section class="run-section overlap-warning">
          <h2>Overlapping changes</h2>
          <ul>
            {run.overlaps.map(overlap => (
              <li key={overlap.runId}>
                <a href={runHref(overlap.runId)}>{overlap.title}</a> · {overlap.files.join(', ')}
              </li>
            ))}
          </ul>
        </section>
      )}
      {run.git && (
        <section class="run-section">
          <h2>Git</h2>
          <dl class="detail-facts">
            <div>
              <dt>Commits ahead</dt>
              <dd>{run.git.ahead}</dd>
            </div>
            <div>
              <dt>Files changed</dt>
              <dd>{run.git.changedFiles.length}</dd>
            </div>
            {run.git.lastCommit && (
              <div>
                <dt>Last commit</dt>
                <dd>
                  {run.git.lastCommit.subject} · {agoText(run.git.lastCommit.at, now)}
                </dd>
              </div>
            )}
            {run.git.newestEdit && (
              <div>
                <dt>Last edit</dt>
                <dd>
                  {run.git.newestEdit.file} · {agoText(run.git.newestEdit.at, now)}
                </dd>
              </div>
            )}
          </dl>
          {run.git.changedFiles.length > 0 && (
            <ul class="changed-files">
              {run.git.changedFiles.map(file => (
                <li key={file}>
                  <code>{file}</code>
                </li>
              ))}
            </ul>
          )}
        </section>
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
        <header class="view-header">
          <a class="back-link mobile-back" href="#/">
            ← Chats
          </a>
          <h1>Worker</h1>
        </header>
        <LoadNotice loading={!detail.error} error={detail.error} retry={detail.refresh} />
      </>
    )
  const owner = state?.chats.find(chat => chat.id === run.chatId)
  const back = run.chatId ? chatHref(run.chatId) : '#/'
  const active = run.status === 'running'
  const ended = run.finishedAt ? Date.parse(run.finishedAt) : now
  const elapsed = durationText(minutesBetween(run.createdAt, ended) ?? 0)
  return (
    <>
      <header class="view-header">
        <a class="back-link mobile-back" href={back}>
          ← {owner ? 'Chat' : 'Chats'}
        </a>
        <div class="view-heading">
          <div class="view-title">
            <EngineMark engine={run.engine} />
            <h1>{run.title}</h1>
          </div>
          <div class="view-meta">
            <span>
              <StatusDot status={run.status} engine={run.engine} />
              {runActivity(run, now)}
            </span>
            <span class="view-folder" title={run.worktree ?? run.folder}>
              {folderName(run.worktree ?? run.folder)}
            </span>
          </div>
        </div>
        <div class="view-actions">
          <button
            class="button button-secondary"
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
          </button>
          {active ? (
            <button class="button button-secondary" type="button" disabled={offline} onClick={() => stop(run)}>
              Stop worker
            </button>
          ) : (
            <button class="button button-secondary" type="button" disabled={offline} onClick={() => retry(run)}>
              Retry with another agent
            </button>
          )}
        </div>
      </header>
      <div class="thread worker-detail">
        <div class="thread-inner">
          <ErrorBanner text={run.error} />
          <ErrorBanner text={copy.error} />
          <section class="run-section">
            <h2>Worker details</h2>
            <dl class="detail-facts">
              <div>
                <dt>Agent</dt>
                <dd>
                  <EngineMark engine={run.engine} labelled />
                  {run.model && ` · ${run.model}`}
                </dd>
              </div>
              {detail.data?.effort && (
                <div>
                  <dt>Effort</dt>
                  <dd>{detail.data.effort}</dd>
                </div>
              )}
              <div>
                <dt>Chat</dt>
                <dd>{run.chatId ? <a href={back}>{owner?.title ?? 'Chat'}</a> : 'Independent worker'}</dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>
                  <time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString()}</time>
                </dd>
              </div>
              <div>
                <dt>Elapsed</dt>
                <dd>{elapsed}</dd>
              </div>
              <div>
                <dt>Turns started</dt>
                <dd>{run.turns}</dd>
              </div>
              <div>
                <dt>Folder</dt>
                <dd>
                  <code class="path-label">{run.folder}</code>
                </dd>
              </div>
              {run.worktree && (
                <div>
                  <dt>Worktree</dt>
                  <dd>
                    <code class="path-label">{run.worktree}</code>
                  </dd>
                </div>
              )}
              {run.branch && (
                <div>
                  <dt>Branch</dt>
                  <dd>
                    <code class="path-label">{run.branch}</code>
                  </dd>
                </div>
              )}
            </dl>
          </section>
          <LoadNotice loading={!detail.data && !detail.error} error={detail.error} retry={detail.refresh} />
          {detail.data && <RunOutput run={detail.data} now={now} />}
        </div>
      </div>
      {!active && (
        <Composer
          name="Message worker"
          blocked={offline}
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
