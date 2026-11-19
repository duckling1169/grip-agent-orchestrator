import { ArrowUp } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'

import type { LeaderSettings } from '@contracts/api'
import { LEADER_ENGINES } from '@contracts/engines'
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
  const [sending, setSending] = useState(false)
  const empty = text.trim() === ''
  const stopping = running && empty
  const act = (action: () => Promise<unknown>) => action().catch(error => onError(error instanceof Error ? error.message : String(error)))

  const submit = async () => {
    if (stopping) return void act(() => api.stop())
    if (empty || sending) return
    setSending(true)
    await act(async () => {
      await api.send(text.trim(), crypto.randomUUID())
      setText('')
    })
    setSending(false)
  }

  const label = stopping ? 'Stop Moxy' : running ? 'Queue message' : 'Send'
  return (
    <div className="composer">
      <div className="composer-inner">
        <div className="box">
          <label className="sr-only" htmlFor="message">
            Message Moxy
          </label>
          <textarea
            id="message"
            rows={1}
            value={text}
            disabled={offline}
            onChange={event => setText(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
              event.preventDefault()
              if (!empty) void submit()
            }}
          />
          <button
            className="ghost send"
            type="button"
            aria-label={label}
            title={label}
            disabled={offline || sending || (empty && !running)}
            onClick={() => void submit()}
          >
            {stopping ? <StopIcon /> : <ArrowUp />}
          </button>
        </div>
        <div className="footer">
          <Picker
            label="Orchestrator"
            trigger={<EngineIcon engine={leader.engine} className="size-3.5" />}
            triggerLabel={`Orchestrator: ${engineName(leader.engine)}`}
            choices={LEADER_ENGINES.map(engine => ({ value: engine, label: engineName(engine) }))}
            value={leader.engine}
            disabled={offline}
            isLocked={value => value !== leader.engine}
            lockedNote="Switching the Orchestrator is not available yet"
            icon={value => value && <EngineIcon engine={value as LeaderSettings['engine']} className="size-3.5" />}
            onChange={() => undefined}
          />
          <Picker
            label="Model"
            trigger={leader.model ?? 'Default model'}
            triggerLabel={`Orchestrator model: ${leader.model ?? 'default'}`}
            choices={withCurrent([{ value: null, label: 'Default' }], leader.model)}
            value={leader.model}
            disabled={offline}
            onChange={model => void act(() => api.configure({ model, effort: leader.effort }))}
          />
          <Picker
            label="Effort"
            trigger={leader.effort ?? 'Default effort'}
            triggerLabel={`Orchestrator effort: ${leader.effort ?? 'default'}`}
            choices={withCurrent([{ value: null, label: 'Default' }], leader.effort)}
            value={leader.effort}
            disabled={offline}
            onChange={effort => void act(() => api.configure({ model: leader.model, effort }))}
          />
        </div>
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
  isLocked,
  lockedNote,
  icon,
  onChange,
}: {
  label: string
  trigger: ReactNode
  triggerLabel: string
  choices: Choice[]
  value: string | null
  disabled: boolean
  isLocked?: (value: string | null) => boolean
  lockedNote?: string
  icon?: (value: string | null) => ReactNode
  onChange: (value: string | null) => void
}) {
  const key = (value: string | null) => value ?? ''
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button className="ghost pick" type="button" aria-label={triggerLabel} title={label}>
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
          {choices.map(choice => {
            const locked = isLocked?.(choice.value) ?? false
            return (
              <DropdownMenuRadioItem
                key={key(choice.value)}
                value={key(choice.value)}
                disabled={locked}
                title={locked ? lockedNote : undefined}
                className={cn('gap-2', locked && 'opacity-50')}
              >
                {icon?.(choice.value)}
                {choice.label}
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
