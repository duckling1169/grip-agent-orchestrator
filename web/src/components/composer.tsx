import { ArrowUp, Plus } from 'lucide-react'
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { LeaderSettings } from '@contracts/api'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_MB, MAX_ATTACHMENTS } from '@contracts/attachments'
import { LEADER_ENGINES } from '@contracts/engines'
import { DraftAttachment } from '@/components/attachments'
import { EngineIcon, engineName } from '@/components/engine-icon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api } from '@/lib/api'
import { composerGutter, ghost, linkButton, readingColumn } from '@/lib/styles'
import { useFetched } from '@/lib/use-fetched'
import { cn } from '@/lib/utils'

type Choice = { value: string | null; label: string }

export function Composer({
  leader,
  running,
  offline,
  onError,
}: {
  leader: LeaderSettings
  running: boolean
  offline: boolean
  onError: (message: string) => void
}) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<{ id: number; file: File }[]>([])
  const [sending, setSending] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const nextFileId = useRef(0)
  const uploaded = useRef(new WeakMap<File, string>())
  const lastSubmission = useRef<{ text: string; files: typeof files; id: string }>(null)
  const catalog = useFetched(signal => (offline ? Promise.resolve(null) : api.models(leader.engine, signal)), [leader.engine, offline])
  const models = catalog.data?.engine === leader.engine ? catalog.data.models : []
  const selectedModel =
    models.find(model => model.id === leader.model) ?? (leader.model === null ? models.find(model => model.isDefault) : undefined)
  const modelLabel = selectedModel?.label ?? leader.model ?? 'Default model'
  const empty = text.trim() === '' && files.length === 0
  const stopping = running && empty
  const act = (action: () => Promise<unknown>) => action().catch(error => onError(error instanceof Error ? error.message : String(error)))

  const addFiles = (selected: FileList) => {
    if (offline || sending) return
    if (files.length + selected.length > MAX_ATTACHMENTS) {
      onError(`Attach up to ${MAX_ATTACHMENTS} files per message`)
      return
    }
    const selectedFiles = Array.from(selected)
    const oversized = selectedFiles.find(file => file.size > MAX_ATTACHMENT_BYTES)
    if (oversized) {
      onError(`${oversized.name} is too large. Each file must be ${MAX_ATTACHMENT_MB} MB or smaller.`)
      return
    }
    const added = selectedFiles.map(file => ({ file, id: nextFileId.current++ }))
    setFiles(current => [...current, ...added])
  }

  const submit = async () => {
    if (stopping) return void act(() => api.stop())
    if (empty || offline || sending) return
    setSending(true)
    await act(async () => {
      const message = text.trim()
      const previous = lastSubmission.current
      const id = previous?.text === message && previous.files === files ? previous.id : crypto.randomUUID()
      lastSubmission.current = { text: message, files, id }
      const attachments: string[] = []
      for (const { file } of files) {
        const uploadId = uploaded.current.get(file) ?? (await api.upload(file)).id
        uploaded.current.set(file, uploadId)
        attachments.push(uploadId)
      }
      await api.send(message, id, attachments)
      setText('')
      setFiles([])
      lastSubmission.current = null
    })
    setSending(false)
  }

  const label = stopping ? 'Stop Moxy' : running ? 'Queue message' : 'Send'
  return (
    <div className={cn(composerGutter, 'pt-1.5 pb-4 max-md:pb-2.5')}>
      <div className={readingColumn}>
        <div
          className="cursor-text rounded-[10px] border bg-popover p-1"
          data-testid="message-box"
          onClick={event => {
            if (!(event.target as Element).closest('button')) textarea.current?.focus()
          }}
          onDragOver={event => {
            if (event.dataTransfer.types.includes('Files')) event.preventDefault()
          }}
          onDrop={event => {
            if (!event.dataTransfer.files.length) return
            event.preventDefault()
            addFiles(event.dataTransfer.files)
          }}
        >
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 p-1.5 text-xs">
              {files.map(({ file, id }) => (
                <DraftAttachment
                  key={id}
                  file={file}
                  disabled={offline || sending}
                  onRemove={() => setFiles(current => current.filter(item => item.id !== id))}
                />
              ))}
            </div>
          )}
          <input
            ref={picker}
            type="file"
            hidden
            multiple
            onChange={event => {
              if (event.target.files) addFiles(event.target.files)
              event.target.value = ''
            }}
          />
          <div className="flex items-end gap-1">
            <button
              className={cn(ghost, 'size-10 shrink-0 justify-center rounded-md p-0 text-muted-foreground [&_svg]:size-5')}
              type="button"
              aria-label="Attach files"
              title="Attach files"
              disabled={offline || sending}
              onClick={() => picker.current?.click()}
            >
              <Plus />
            </button>
            <label className="sr-only" htmlFor="message">
              Message Moxy
            </label>
            <textarea
              ref={textarea}
              id="message"
              rows={1}
              className="block max-h-50 min-h-10 w-full min-w-0 resize-none bg-transparent py-2 text-foreground outline-none field-sizing-content placeholder:text-muted-foreground max-md:text-base"
              value={text}
              placeholder="What's up?"
              disabled={offline}
              readOnly={sending}
              onChange={event => setText(event.target.value)}
              onPaste={event => {
                if (!event.clipboardData.files.length) return
                if (!event.clipboardData.getData('text/plain')) event.preventDefault()
                addFiles(event.clipboardData.files)
              }}
              onKeyDown={event => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
                event.preventDefault()
                if (!empty) void submit()
              }}
            />
            <button
              className={cn(ghost, 'size-10 shrink-0 justify-center rounded-full p-0 hover:bg-transparent hover:opacity-85')}
              type="button"
              aria-label={label}
              title={label}
              disabled={offline || sending || (empty && !running)}
              onClick={() => void submit()}
            >
              <span className="flex size-7 items-center justify-center rounded-full bg-foreground text-background [&_svg]:size-4">
                {stopping ? <StopIcon /> : <ArrowUp />}
              </span>
            </button>
          </div>
        </div>
        <div className="mt-1.5 flex items-center justify-end gap-0.5 text-xs">
          <Picker
            label="Next-turn orchestrator"
            trigger={<EngineIcon engine={leader.engine} className="size-3.5" />}
            triggerLabel={`Orchestrator: ${engineName(leader.engine)}`}
            choices={LEADER_ENGINES.map(engine => ({ value: engine, label: engineName(engine) }))}
            value={leader.engine}
            disabled={offline}
            icon={value => value && <EngineIcon engine={value as LeaderSettings['engine']} className="size-3.5" />}
            onChange={engine => {
              if (engine) void act(() => api.configure({ engine: engine as LeaderSettings['engine'], model: null, effort: null }))
            }}
          />
          <Picker
            label="Next-turn model"
            trigger={modelLabel}
            triggerLabel={`Next-turn model: ${modelLabel}`}
            choices={withCurrent(
              [{ value: null, label: 'Default' }, ...models.map(model => ({ value: model.id, label: model.label }))],
              leader.model,
            )}
            value={leader.model}
            disabled={offline}
            onChange={model => void act(() => api.configure({ engine: leader.engine, model, effort: null }))}
          />
          <Picker
            label="Next-turn effort"
            trigger={leader.effort ?? 'Default effort'}
            triggerLabel={`Next-turn effort: ${leader.effort ?? 'default'}`}
            choices={withCurrent(
              [{ value: null, label: 'Default' }, ...(selectedModel?.efforts ?? []).map(effort => ({ value: effort, label: effort }))],
              leader.effort,
            )}
            value={leader.effort}
            disabled={offline}
            onChange={effort => void act(() => api.configure({ engine: leader.engine, model: leader.model, effort }))}
          />
        </div>
        {(catalog.error || catalog.data?.error) && (
          <div className="text-xs text-destructive">
            Model list: {catalog.error ?? catalog.data?.error}{' '}
            <button className={linkButton} type="button" disabled={offline} onClick={catalog.reload}>
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="2" fill="currentColor" />
    </svg>
  )
}

function withCurrent(choices: Choice[], current: string | null): Choice[] {
  return current === null || choices.some(choice => choice.value === current) ? choices : [...choices, { value: current, label: current }]
}

function Picker({
  label,
  trigger,
  triggerLabel,
  choices,
  value,
  disabled,
  icon,
  onChange,
}: {
  label: string
  trigger: ReactNode
  triggerLabel: string
  choices: Choice[]
  value: string | null
  disabled: boolean
  icon?: (value: string | null) => ReactNode
  onChange: (value: string | null) => void
}) {
  const key = (value: string | null) => value ?? ''
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          className={cn(ghost, 'min-h-6.5 gap-1 px-1.5 py-0.75 text-xs text-muted-foreground')}
          type="button"
          aria-label={triggerLabel}
          title={label}
        >
          {trigger}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="min-w-52">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={key(value)}
          onValueChange={next => {
            const choice = choices.find(item => key(item.value) === next)
            if (choice && choice.value !== value) onChange(choice.value)
          }}
        >
          {choices.map(choice => (
            <DropdownMenuRadioItem key={key(choice.value)} value={key(choice.value)} className="gap-2">
              {icon && <span aria-hidden="true">{icon(choice.value)}</span>}
              {choice.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
