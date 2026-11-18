import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'

import { durationText } from '../../../src/quota/usage.js'
import { api } from '../api.js'
import { useDetail } from '../state.js'
import type { AppState, Engine, RunSummary, Worktree } from '../types.js'
import { EngineMark, ErrorBanner, engines, folderName, isEngine, Time, touchButton, useAction } from './common.js'
import { FolderPicker } from './folder-picker.js'
import { ResponsiveDialog } from './responsive-dialog.js'

type StartMode = { kind: 'chat' | 'worker' } | { kind: 'retry'; run: RunSummary }
type BriefKind = 'text' | 'path'

function FolderField({
  value,
  change,
  recent,
  disabled,
}: {
  value: string
  change: (value: string) => void
  recent: string[]
  disabled: boolean
}) {
  const id = useId()
  const [picking, setPicking] = useState(false)

  return (
    <div className="grid min-w-0 gap-2">
      <Label htmlFor={id}>Folder</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          className="min-h-11 min-w-0 md:min-h-9"
          autoComplete="off"
          placeholder="Choose a folder"
          required
          value={value}
          onChange={event => change(event.currentTarget.value)}
          disabled={disabled}
        />
        <Button
          variant="outline"
          type="button"
          className="min-h-11 md:min-h-9"
          onClick={() => setPicking(true)}
          disabled={disabled}
          aria-haspopup="dialog"
        >
          Browse
        </Button>
      </div>
      {picking && (
        <FolderPicker
          start={value.trim() || null}
          recent={recent}
          close={() => setPicking(false)}
          choose={path => {
            change(path)
            setPicking(false)
          }}
        />
      )}
    </div>
  )
}

const readModels = (_: string, signal: AbortSignal) => api.models(signal)
const defaultChoice = 'default'

/**
 * An agent's models and the efforts the chosen one offers; an empty string is the agent's default.
 * `pickModel` returns the next choice, resetting an effort the new model doesn't offer.
 */
export function useModelChoices(engine: Engine, model: string, effort: string) {
  const catalogs = useDetail('models', readModels)
  const catalog = catalogs.data?.find(list => list.engine === engine)
  const chosen = catalog?.models.find(option => option.id === model)
  const allEfforts = [...new Set(catalog?.models.flatMap(option => option.efforts) ?? [])]
  const efforts = engine === 'agy' ? [] : (chosen?.efforts ?? allEfforts)
  const defaultEffort = (chosen ?? catalog?.models.find(option => option.isDefault))?.defaultEffort ?? null
  const pickModel = (value: string) => {
    const next = catalog?.models.find(option => option.id === value)
    return { model: value, effort: effort && !(next?.efforts ?? allEfforts).includes(effort) ? '' : effort }
  }
  return {
    models: catalog?.models ?? [],
    chosen,
    efforts,
    defaultEffort,
    error: catalogs.error ?? catalog?.error,
    loading: !catalogs.data && !catalogs.error,
    pickModel,
  }
}

/** Model and effort pickers for the start dialogs. */
function ModelFields({
  engine,
  model,
  effort,
  disabled,
  choose,
}: {
  engine: Engine
  model: string
  effort: string
  disabled: boolean
  choose: (next: { model: string; effort: string }) => void
}) {
  const id = useId()
  const { models, chosen, efforts, defaultEffort, error, loading, pickModel: next } = useModelChoices(engine, model, effort)
  const catalog = { models }
  const effortPlaceholder = engine === 'agy' ? 'Set by the model' : 'Not used by this model'
  const pickModel = (value: string) => choose(next(value))
  const label = undefined
  const trigger = 'min-h-11 w-full min-w-0 md:min-h-9'

  return (
    <div className="grid items-start gap-3 min-[360px]:grid-cols-2">
      <div className="grid min-w-0 gap-2">
        <Label className={label} htmlFor={`${id}-model`}>
          Model
        </Label>
        <Select
          value={model ? `model:${model}` : defaultChoice}
          onValueChange={value => pickModel(value === defaultChoice ? '' : value.slice('model:'.length))}
          disabled={disabled || loading}
        >
          <SelectTrigger id={`${id}-model`} className={trigger}>
            <SelectValue placeholder="Agent default" />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value={defaultChoice}>{loading ? 'Loading models…' : 'Agent default'}</SelectItem>
            {catalog?.models.map(option => (
              <SelectItem key={option.id} value={`model:${option.id}`}>
                {option.label}
              </SelectItem>
            ))}
            {/* A model chosen elsewhere, or no longer listed, still shows by its id. */}
            {model && !chosen && <SelectItem value={`model:${model}`}>{model}</SelectItem>}
          </SelectContent>
        </Select>
        {error && <ErrorBanner text={`Couldn't list models. ${error}`} />}
      </div>
      <div className="grid min-w-0 gap-2">
        <Label className={label} htmlFor={`${id}-effort`}>
          Effort
        </Label>
        <Select
          value={effort ? `effort:${effort}` : defaultChoice}
          onValueChange={value => choose({ model, effort: value === defaultChoice ? '' : value.slice('effort:'.length) })}
          disabled={disabled || !efforts.length}
        >
          <SelectTrigger id={`${id}-effort`} className={trigger}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value={defaultChoice}>
              {efforts.length || (loading && engine !== 'agy') ? `Default${defaultEffort ? ` (${defaultEffort})` : ''}` : effortPlaceholder}
            </SelectItem>
            {efforts.map(option => (
              <SelectItem key={option} value={`effort:${option}`}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

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
  const id = useId()
  const [engine, setEngine] = useState<Engine>(mode.kind === 'retry' && mode.run.engine === 'claude' ? 'codex' : 'claude')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [briefKind, setBriefKind] = useState<BriefKind>('text')
  const [brief, setBrief] = useState('')
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
  const [folder, setFolder] = useState(folders[0] ?? '')
  const disabled = offline || action.busy

  return (
    <ResponsiveDialog
      title={title}
      busy={action.busy}
      close={close}
      actions={
        <>
          <Button variant="outline" type="button" onClick={close} disabled={action.busy}>
            Cancel
          </Button>
          <Button type="submit" form={id} disabled={disabled}>
            {action.busy ? 'Starting…' : isRetry ? 'Retry worker' : title}
          </Button>
        </>
      }
    >
      <form
        id={id}
        className="grid gap-4"
        onSubmit={event => {
          event.preventDefault()
          if (disabled) return
          void action.perform(async () => {
            const options = { engine, model: model || undefined, effort: effort || undefined }
            if (mode.kind === 'retry') {
              const run = await api.retry(mode.run.id, options)
              started('run', run.id, run.quotaNote)
            } else if (mode.kind === 'chat') {
              const chat = await api.startChat({ ...options, folder: folder.trim() })
              started('chat', chat.id)
            } else {
              const run = await api.startRun({
                ...options,
                folder: folder.trim(),
                brief: briefKind === 'path' ? { path: brief.trim() } : { text: brief.trim() },
              })
              started('run', run.id, run.quotaNote)
            }
          })
        }}
      >
        {mode.kind === 'retry' && (
          <p className="text-sm wrap-anywhere text-muted-foreground">
            Reuse the brief from <strong className="font-medium text-foreground">{mode.run.title}</strong>.
          </p>
        )}
        <div className="grid gap-2">
          <span id={`${id}-agent`} className="text-sm leading-none font-medium">
            Agent
          </span>
          <RadioGroup
            aria-labelledby={`${id}-agent`}
            value={engine}
            disabled={disabled}
            className="gap-1.5"
            onValueChange={value => {
              if (!isEngine(value)) return
              setEngine(value)
              setModel('')
              setEffort('')
            }}
          >
            {engines.map(option => {
              const unavailable = isChat && option !== 'claude'
              const current = mode.kind === 'retry' && option === mode.run.engine
              const quota = state?.quota.providers.find(provider => provider.provider === option)
              const windows = quota?.windows.filter(
                window => !window.stale && (!window.resetsAt || Date.parse(window.resetsAt) > Date.now()),
              )
              const left = windows?.length ? Math.min(...windows.map(window => Math.max(0, Math.round(100 - window.usedPercent)))) : null
              return (
                <Label
                  key={option}
                  htmlFor={`${id}-${option}`}
                  className="min-h-11 cursor-pointer gap-3 rounded-md border px-3 py-2 has-[[data-state=checked]]:bg-muted has-[:disabled]:cursor-default"
                >
                  <RadioGroupItem id={`${id}-${option}`} value={option} disabled={unavailable || current} />
                  <EngineMark engine={option} labelled />
                  <span className="ml-auto text-right text-xs font-normal text-muted-foreground">
                    {unavailable ? 'Worker only' : current ? 'Original agent' : left === null ? 'Quota unknown' : `${left}% left`}
                  </span>
                </Label>
              )
            })}
          </RadioGroup>
        </div>
        {!isRetry && <FolderField value={folder} change={setFolder} recent={folders} disabled={disabled} />}
        <ModelFields
          engine={engine}
          model={model}
          effort={effort}
          choose={next => {
            setModel(next.model)
            setEffort(next.effort)
          }}
          disabled={disabled}
        />
        {mode.kind === 'worker' && (
          <>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-format`}>Brief format</Label>
              <Select
                value={briefKind}
                onValueChange={value => {
                  setBriefKind(value === 'path' ? 'path' : 'text')
                  setBrief('')
                }}
                disabled={disabled}
              >
                <SelectTrigger id={`${id}-format`} className="min-h-11 w-full md:min-h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem value="text">Write a brief</SelectItem>
                  <SelectItem value="path">Use a brief file</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-brief`}>{briefKind === 'path' ? 'Brief file path' : 'Task brief'}</Label>
              {briefKind === 'path' ? (
                <Input
                  id={`${id}-brief`}
                  required
                  disabled={disabled}
                  placeholder="Path relative to folder or absolute"
                  value={brief}
                  onChange={event => setBrief(event.currentTarget.value)}
                />
              ) : (
                <Textarea
                  id={`${id}-brief`}
                  rows={4}
                  required
                  disabled={disabled}
                  placeholder="What should the worker do?"
                  value={brief}
                  onChange={event => setBrief(event.currentTarget.value)}
                />
              )}
            </div>
          </>
        )}
        <ErrorBanner text={action.error} />
      </form>
    </ResponsiveDialog>
  )
}

export function ConfirmDialog({
  title,
  description,
  label,
  busyLabel = 'Stopping…',
  close,
  confirm,
  offline,
}: {
  title: string
  description: ReactNode
  label: string
  busyLabel?: string
  close: () => void
  confirm: () => Promise<void>
  offline: boolean
}) {
  const action = useAction()
  const opener = useRef<HTMLElement | null>(null)
  return (
    <AlertDialog open onOpenChange={open => !open && !action.busy && close()}>
      <AlertDialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto data-[size=default]:sm:max-w-sm"
        onOpenAutoFocus={() => {
          if (!opener.current && document.activeElement instanceof HTMLElement) opener.current = document.activeElement
        }}
        onCloseAutoFocus={event => {
          event.preventDefault()
          if (opener.current?.isConnected) opener.current.focus({ preventScroll: true })
        }}
      >
        <AlertDialogHeader className="place-items-start text-left">
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription className="wrap-anywhere">{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <ErrorBanner text={action.error} />
        <AlertDialogFooter className="flex-row flex-wrap justify-end *:min-h-11 md:*:min-h-9">
          <AlertDialogCancel disabled={action.busy}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            type="button"
            disabled={offline || action.busy}
            onClick={() =>
              void action.perform(async () => {
                await confirm()
                close()
              })
            }
          >
            {action.busy ? busyLabel : label}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function RenameDialog({
  title,
  current,
  close,
  rename,
  offline,
}: {
  title: string
  current: string
  close: () => void
  rename: (title: string) => Promise<void>
  offline: boolean
}) {
  const action = useAction()
  const id = useId()
  const [value, setValue] = useState(current)
  const next = value.trim()
  const field = useRef<HTMLInputElement>(null)
  // The dialog focuses its title when it opens; then the name is selected, ready to type over.
  useEffect(() => {
    const frame = requestAnimationFrame(() => field.current?.select())
    return () => cancelAnimationFrame(frame)
  }, [])
  return (
    <ResponsiveDialog
      title={title}
      busy={action.busy}
      close={close}
      actions={
        <>
          <Button variant="outline" type="button" onClick={close} disabled={action.busy}>
            Cancel
          </Button>
          <Button type="submit" form={id} disabled={offline || action.busy || !next || next === current}>
            {action.busy ? 'Renaming…' : 'Rename'}
          </Button>
        </>
      }
    >
      <form
        id={id}
        className="grid gap-2"
        onSubmit={event => {
          event.preventDefault()
          if (!next || next === current) return
          void action.perform(async () => {
            await rename(next)
            close()
          })
        }}
      >
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input id={`${id}-name`} ref={field} value={value} maxLength={200} onChange={event => setValue(event.target.value)} />
        <ErrorBanner text={action.error} />
      </form>
    </ResponsiveDialog>
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
  const [confirm, setConfirm] = useState<Worktree>()
  const [removed, setRemoved] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const trees = listing.data?.filter(tree => tree.run && tree.run.status !== 'running' && !removed.includes(tree.path))

  return (
    <ResponsiveDialog
      title="Worktrees"
      close={close}
      actions={
        <Button variant="outline" type="button" onClick={close}>
          Close
        </Button>
      }
    >
      <div className="grid gap-3">
        <ErrorBanner text={listing.error} />
        {notice && <p role="status">{notice}</p>}
        {trees ? (
          trees.length ? (
            <ul className="divide-y rounded-md border">
              {trees.map(tree => (
                <li className="flex items-start gap-3 p-3" key={tree.path}>
                  <div className="grid min-w-0 flex-1 gap-1">
                    <strong className="wrap-anywhere">{tree.run?.title ?? folderName(tree.path)}</strong>
                    <code className="text-xs break-all text-muted-foreground">{tree.path}</code>
                    <small className="text-xs text-muted-foreground">
                      {sizeLabel(tree)}
                      {tree.ageMs === null ? '' : ` · ${durationText(Math.round(tree.ageMs / 60_000))} old`}
                    </small>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    className={touchButton}
                    disabled={offline}
                    onClick={() => setConfirm(tree)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No finished worktrees.</p>
          )
        ) : listing.error ? (
          <Button className="justify-self-start" variant="outline" type="button" onClick={listing.refresh}>
            Try again
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground" role="status">
            Loading worktrees…
          </p>
        )}
      </div>
      {confirm && (
        <ConfirmDialog
          title={`Remove ${folderName(confirm.path)}?`}
          description={
            <>
              This deletes the worktree folder and discards any uncommitted changes. Grip keeps unmerged commits on their branch.
              <code className="mt-2 block text-xs break-all">{confirm.path}</code>
            </>
          }
          label="Remove worktree"
          busyLabel="Removing…"
          offline={offline}
          close={() => setConfirm(undefined)}
          confirm={async () => {
            const result = await api.removeWorktree(confirm.path)
            setRemoved(paths => [...paths, confirm.path])
            setNotice(result.branchDeleted ? 'Worktree and merged branch removed.' : 'Worktree removed. Branch kept.')
            listing.refresh()
          }}
        />
      )}
    </ResponsiveDialog>
  )
}

export function SettingsDialog({
  state,
  close,
  section = 'all',
}: {
  state: AppState | null
  close: () => void
  section?: 'all' | 'updates' | 'settings'
}) {
  const history = state?.claw.history?.slice(-5).reverse() ?? []
  return (
    <ResponsiveDialog
      title={section === 'updates' ? 'Claw updates' : 'Settings'}
      close={close}
      actions={
        <Button variant="outline" type="button" onClick={close}>
          Close
        </Button>
      }
    >
      <div className="grid gap-4 text-sm">
        {section !== 'settings' && (
          <section className="grid gap-2">
            {section === 'all' && <h3 className="font-medium">Claw updates</h3>}
            {history.length ? (
              <ol className="divide-y rounded-md border">
                {history.map(event => (
                  <li className="grid gap-1 p-3 wrap-anywhere" key={`${event.at}-${event.kind}`}>
                    <div>
                      <strong className="font-medium">
                        {
                          {
                            installed: 'Installed',
                            updated: 'Updated',
                            'rolled-back': 'Rolled back',
                            'gate-failed': 'Health check failed',
                          }[event.kind]
                        }
                      </strong>
                      {(event.from || event.to) && (
                        <span> {event.from && event.to ? `${event.from} → ${event.to}` : (event.to ?? event.from)}</span>
                      )}
                    </div>
                    <Time className="text-xs text-muted-foreground" at={event.at} full />
                    {event.detail && <p>{event.detail}</p>}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-muted-foreground">No recorded updates.</p>
            )}
          </section>
        )}
        {section === 'all' && <Separator />}
        {section !== 'updates' && (
          <>
            <section className="grid gap-2">
              <h3 className="font-medium">Principal</h3>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 [&_dd]:wrap-anywhere [&_dt]:text-muted-foreground">
                <dt>Machine</dt>
                <dd>{state?.principal.host ?? 'Unknown'}</dd>
                <dt>Claw</dt>
                <dd>
                  {state?.claw.status ?? 'Unknown'}
                  {state?.claw.version ? ` · ${state.claw.version}` : ''}
                </dd>
                <dt>Keep awake</dt>
                <dd>{state?.keepAwake.supported ? (state.keepAwake.holding ? 'Holding' : 'Idle') : 'Unavailable'}</dd>
                {state?.you && (
                  <>
                    <dt>Signed in</dt>
                    <dd>{state.you}</dd>
                  </>
                )}
              </dl>
            </section>
            <Separator />
            <section className="grid gap-2">
              <h3 className="font-medium">Notifications</h3>
              <p className="text-muted-foreground">Web Push will be available in a later update.</p>
            </section>
          </>
        )}
      </div>
    </ResponsiveDialog>
  )
}
