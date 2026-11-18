import { useId, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

import { api } from '../api.js'
import { useDetail } from '../state.js'
import type { AppState, Engine, RunSummary } from '../types.js'
import { EngineMark, engines, ErrorBanner, isEngine, useAction } from './common.js'
import { FolderPicker } from './folder-picker.js'
import { ModelFields } from './model-fields.js'
import { ResponsiveDialog } from './responsive-dialog.js'

const readLeaders = (_: string, signal: AbortSignal) => api.leaders(signal)
const readEngines = (_: string, signal: AbortSignal) => api.engines(signal)
const skipLeaders = async () => null

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
  // Only a chat asks which agents can lead; the check starts each agent briefly.
  const leaders = useDetail(isChat ? 'leaders' : 'none', isChat ? readLeaders : skipLeaders)
  // Every engine whose CLI is installed here; until that is known, the three Grip started with.
  const installed = useDetail('engines', readEngines)
  const offered = installed.data
    ? engines.filter(option => installed.data?.some(info => info.engine === option && info.installed))
    : engines.slice(0, 3)
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
            {offered.map(option => {
              const leader = isChat ? leaders.data?.find(item => item.engine === option) : undefined
              const unavailable = isChat && option !== 'claude' && !leader?.available
              const why = leader && !leader.available ? leader.reason : leaders.error ? "Couldn't check" : 'Checking…'
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
                    {unavailable ? why : current ? 'Original agent' : left === null ? 'Quota unknown' : `${left}% left`}
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
