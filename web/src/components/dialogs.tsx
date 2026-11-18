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
import { Separator } from '@/components/ui/separator'

import { durationText } from '../../../src/quota/usage.js'
import { api } from '../api.js'
import { useDetail } from '../state.js'
import type { AppState, Worktree } from '../types.js'
import { ErrorBanner, folderName, Time, touchButton, useAction } from './common.js'
import { ResponsiveDialog } from './responsive-dialog.js'

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
