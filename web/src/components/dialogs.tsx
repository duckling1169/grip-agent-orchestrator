import { useEffect, useId, useRef, useState } from 'preact/hooks'

import { durationText } from '../../../src/quota/usage.js'
import { api } from '../api.js'
import { useDetail } from '../state.js'
import type { AppState, Engine, RunSummary, Worktree } from '../types.js'
import { Dialog, EngineMark, ErrorBanner, engines, folderName, useAction } from './common.js'

type StartMode = { kind: 'chat' | 'worker' } | { kind: 'retry'; run: RunSummary }

export function StartDialog({
  mode,
  state,
  offline,
  close,
  started,
}: {
  mode: StartMode
  state: AppState | null
  offline: boolean
  close: () => void
  started: (kind: 'chat' | 'run', id: string, note?: string) => void
}) {
  const listId = useId()
  const [engine, setEngine] = useState<Engine>(mode.kind === 'retry' && mode.run.engine === 'claude' ? 'codex' : 'claude')
  const [briefKind, setBriefKind] = useState<'text' | 'path'>('text')
  const action = useAction()
  const isChat = mode.kind === 'chat'
  const isRetry = mode.kind === 'retry'
  const title = isChat ? 'Start a chat' : isRetry ? 'Retry with another agent' : 'Start one worker'
  const folders = [
    ...new Set(
      [
        ...(state?.chats.map(chat => ({ folder: chat.folder, at: chat.updatedAt })) ?? []),
        ...(state?.runs.map(run => ({ folder: run.folder, at: run.createdAt })) ?? []),
      ]
        .sort((a, b) => b.at.localeCompare(a.at))
        .flatMap(item => (item.folder ? [item.folder] : [])),
    ),
  ]
  const disabled = offline || action.busy

  return (
    <Dialog title={title} busy={action.busy} close={close}>
      <form
        class="modal-form"
        onSubmit={event => {
          event.preventDefault()
          if (disabled) return
          const fields = new FormData(event.currentTarget)
          const value = (key: string) => String(fields.get(key) ?? '').trim()
          void action.perform(async () => {
            const model = value('model') || undefined
            const effort = value('effort') || undefined
            if (isRetry) {
              const run = await api.retry(mode.run.id, { engine, model, effort })
              started('run', run.id, run.quotaNote)
            } else if (isChat) {
              const chat = await api.startChat({ engine, model, effort, folder: value('folder'), message: value('message') })
              started('chat', chat.id)
            } else {
              const brief = briefKind === 'path' ? { path: value('brief') } : { text: value('brief') }
              const run = await api.startRun({ engine, model, effort, folder: value('folder'), brief })
              started('run', run.id, run.quotaNote)
            }
          })
        }}
      >
        {isRetry && (
          <p class="muted">
            Start a fresh run from the brief for <strong>{mode.run.title}</strong>.
          </p>
        )}
        {isChat && <p class="muted form-note">Claude can host a chat. Codex and Antigravity can run as workers.</p>}
        <fieldset class="engine-picker" disabled={disabled}>
          <legend>Agent</legend>
          {engines.map(option => {
            const unavailable = isChat && option !== 'claude'
            const current = isRetry && option === mode.run.engine
            const quota = state?.quota.providers.find(provider => provider.provider === option)
            const windows = quota?.windows.filter(window => !window.stale && (!window.resetsAt || Date.parse(window.resetsAt) > Date.now()))
            const left = windows?.length ? Math.min(...windows.map(window => Math.max(0, Math.round(100 - window.usedPercent)))) : null
            return (
              <label class={`engine-option${engine === option ? ' is-selected' : ''}`} key={option}>
                <input
                  checked={engine === option}
                  disabled={unavailable || current}
                  name="engine"
                  type="radio"
                  value={option}
                  onChange={() => setEngine(option)}
                />
                <EngineMark engine={option} labelled />
                <small>
                  {unavailable ? 'Worker only' : current ? 'Original agent' : left === null ? 'Quota unknown' : `${left}% left`}
                </small>
              </label>
            )
          })}
        </fieldset>
        {!isRetry && (
          <label class="form-field">
            <span>Folder</span>
            <input
              name="folder"
              list={listId}
              autoComplete="off"
              placeholder="Absolute path on the principal"
              required
              disabled={disabled}
            />
            <datalist id={listId}>
              {folders.map(folder => (
                <option value={folder} key={folder} />
              ))}
            </datalist>
          </label>
        )}
        <div class="form-columns">
          <label class="form-field">
            <span>
              Model <small>optional</small>
            </span>
            <input name="model" placeholder="Agent default" disabled={disabled} />
          </label>
          <label class="form-field">
            <span>
              Effort <small>optional</small>
            </span>
            <input name="effort" placeholder="Agent default" disabled={disabled} />
          </label>
        </div>
        {isChat && (
          <label class="form-field">
            <span>First message</span>
            <textarea name="message" rows={4} placeholder="What should this chat work on?" required disabled={disabled} />
          </label>
        )}
        {mode.kind === 'worker' && (
          <>
            <label class="form-field">
              <span>Brief format</span>
              <select
                value={briefKind}
                onChange={event => setBriefKind(event.currentTarget.value === 'path' ? 'path' : 'text')}
                disabled={disabled}
              >
                <option value="text">Write a brief</option>
                <option value="path">Use a brief file</option>
              </select>
            </label>
            <label class="form-field">
              <span>{briefKind === 'path' ? 'Brief file path' : 'Task brief'}</span>
              {briefKind === 'path' ? (
                <input name="brief" required disabled={disabled} placeholder="Path relative to folder or absolute" />
              ) : (
                <textarea name="brief" rows={4} required disabled={disabled} placeholder="What should the worker do?" />
              )}
            </label>
          </>
        )}
        <ErrorBanner text={action.error} />
        <div class="dialog-actions">
          <button class="button button-secondary" type="button" onClick={close} disabled={action.busy}>
            Cancel
          </button>
          <button class="button button-primary" type="submit" disabled={disabled}>
            {action.busy ? 'Starting…' : isRetry ? 'Retry worker' : title}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function ConfirmDialog({
  title,
  description,
  label,
  close,
  confirm,
  offline,
}: {
  title: string
  description: string
  label: string
  close: () => void
  confirm: () => Promise<void>
  offline: boolean
}) {
  const action = useAction()
  return (
    <Dialog title={title} busy={action.busy} close={close}>
      <p>{description}</p>
      <ErrorBanner text={action.error} />
      <div class="dialog-actions">
        <button class="button button-secondary" type="button" onClick={close} disabled={action.busy}>
          Cancel
        </button>
        <button
          class="button button-danger"
          type="button"
          disabled={offline || action.busy}
          onClick={() =>
            void action.perform(async () => {
              await confirm()
              close()
            })
          }
        >
          {action.busy ? 'Stopping…' : label}
        </button>
      </div>
    </Dialog>
  )
}

const readWorktrees = (_: string, signal: AbortSignal) => api.worktrees(signal)

function sizeLabel(tree: Worktree) {
  const formatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
  const size =
    tree.bytes >= 1024 ** 3
      ? `${formatter.format(tree.bytes / 1024 ** 3)} GB`
      : tree.bytes >= 1024 ** 2
        ? `${formatter.format(tree.bytes / 1024 ** 2)} MB`
        : `${formatter.format(tree.bytes / 1024)} KB`
  return tree.sizeComplete ? size : `At least ${size}`
}

export function WorktreesDialog({ close, offline }: { close: () => void; offline: boolean }) {
  const listing = useDetail('worktrees', readWorktrees)
  const action = useAction()
  const [confirm, setConfirm] = useState<Worktree>()
  const [removed, setRemoved] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const cancelRemoval = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (confirm) cancelRemoval.current?.focus()
  }, [confirm])
  const trees = listing.data?.filter(tree => tree.run && tree.run.status !== 'running' && !removed.includes(tree.path))
  return (
    <Dialog title="Worktrees" busy={action.busy} close={close}>
      <p class="muted">Review disk use and remove worktrees from finished runs.</p>
      <ErrorBanner text={listing.error ?? action.error} />
      {notice && <p role="status">{notice}</p>}
      {confirm ? (
        <div class="confirm-panel">
          <h3>Remove {folderName(confirm.path)}?</h3>
          <p class="muted">
            This deletes the worktree folder and discards any uncommitted changes. Grip keeps unmerged commits on their branch.
          </p>
          <code class="path-label">{confirm.path}</code>
          <div class="dialog-actions">
            <button
              ref={cancelRemoval}
              class="button button-secondary"
              type="button"
              disabled={action.busy}
              onClick={() => setConfirm(undefined)}
            >
              Cancel
            </button>
            <button
              class="button button-danger"
              type="button"
              disabled={offline || action.busy}
              onClick={() =>
                void action.perform(async () => {
                  const result = await api.removeWorktree(confirm.path)
                  setRemoved(paths => [...paths, confirm.path])
                  setNotice(result.branchDeleted ? 'Worktree and merged branch removed.' : 'Worktree removed. Branch kept.')
                  setConfirm(undefined)
                  listing.refresh()
                })
              }
            >
              {action.busy ? 'Removing…' : 'Remove worktree'}
            </button>
          </div>
        </div>
      ) : trees ? (
        trees.length ? (
          <ul class="worktree-list">
            {trees.map(tree => (
              <li class="worktree-item" key={tree.path}>
                <div>
                  <strong>{tree.run?.title ?? folderName(tree.path)}</strong>
                  <code class="path-label" title={tree.path}>
                    {tree.path}
                  </code>
                  <small class="muted">
                    {sizeLabel(tree)}
                    {tree.ageMs === null ? '' : ` · ${durationText(Math.round(tree.ageMs / 60_000))} old`}
                  </small>
                </div>
                <button class="button button-secondary" type="button" disabled={offline} onClick={() => setConfirm(tree)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted">No finished worktrees.</p>
        )
      ) : listing.error ? (
        <button class="button button-secondary" type="button" onClick={listing.refresh}>
          Try again
        </button>
      ) : (
        <p role="status">Loading worktrees…</p>
      )}
    </Dialog>
  )
}

export function SettingsDialog({ state, close }: { state: AppState | null; close: () => void }) {
  const history = state?.claw.history?.slice(-5).reverse() ?? []
  return (
    <Dialog title="Settings" close={close}>
      <div class="settings-panel">
        <section class="settings-section">
          <h3>Claw updates</h3>
          {history.length ? (
            <ol class="update-history">
              {history.map(event => (
                <li class="update-history-item" key={`${event.at}-${event.kind}`}>
                  <strong>
                    {
                      { installed: 'Installed', updated: 'Updated', 'rolled-back': 'Rolled back', 'gate-failed': 'Health check failed' }[
                        event.kind
                      ]
                    }
                  </strong>
                  {(event.from || event.to) && (
                    <span> {event.from && event.to ? `${event.from} → ${event.to}` : (event.to ?? event.from)}</span>
                  )}
                  <time class="muted" dateTime={event.at}>
                    {new Date(event.at).toLocaleString()}
                  </time>
                  {event.detail && <p>{event.detail}</p>}
                </li>
              ))}
            </ol>
          ) : (
            <p class="muted">No recorded updates.</p>
          )}
        </section>
        <section class="settings-section">
          <h3>Principal</h3>
          <dl class="detail-facts">
            <div>
              <dt>Machine</dt>
              <dd>{state?.principal.host ?? 'Unknown'}</dd>
            </div>
            <div>
              <dt>Claw</dt>
              <dd>
                {state?.claw.status ?? 'Unknown'}
                {state?.claw.version ? ` · ${state.claw.version}` : ''}
              </dd>
            </div>
            <div>
              <dt>Keep awake</dt>
              <dd>{state?.keepAwake.supported ? (state.keepAwake.holding ? 'Holding' : 'Idle') : 'Unavailable'}</dd>
            </div>
            {state?.you && (
              <div>
                <dt>Signed in</dt>
                <dd>{state.you}</dd>
              </div>
            )}
          </dl>
        </section>
        <section>
          <h3>Notifications</h3>
          <p class="muted">Web Push will be available in a later update.</p>
        </section>
      </div>
    </Dialog>
  )
}
