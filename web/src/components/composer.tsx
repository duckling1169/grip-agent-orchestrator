import { ArrowUp, LoaderCircle } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Textarea } from '@/components/ui/textarea'

import type { Engine } from '../types.js'
import { ErrorBanner, useAction } from './common.js'
import { useModelChoices } from './model-fields.js'
import { composerFrame, contentWidth } from './workspace-layout.js'

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
  // The box grows with its text. Browsers without field-sizing get the same from its scroll height.
  useLayoutEffect(() => {
    const box = ref.current
    if (!box || CSS.supports('field-sizing', 'content')) return
    box.style.height = 'auto'
    box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`
  }, [text])

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
        <div className="relative">
          <Textarea
            className="max-h-[40dvh] min-h-11 resize-none overflow-y-auto pr-11 md:min-h-9 md:pr-9"
            id={id}
            ref={ref}
            rows={1}
            value={text}
            disabled={blocked}
            readOnly={action.busy}
            onChange={event => {
              setText(event.currentTarget.value)
              setNotice('')
            }}
            onKeyDown={event => {
              // Enter sends and Shift+Enter starts a new line, as in Claude Code. Phone keyboards have
              // no Shift, so there Enter stays a new line and the Send button sends.
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
              if (!window.matchMedia('(any-pointer: fine)').matches) return
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }}
            placeholder={name}
          />
          <Button
            className="absolute right-2 bottom-2 size-7 rounded-full after:absolute after:-inset-2 md:right-[7px] md:bottom-[7px] md:size-6 md:after:inset-0 [&_svg]:size-3.5"
            size="icon"
            type="submit"
            aria-label={action.busy ? 'Sending' : 'Send message'}
            disabled={!text.trim() || blocked || action.busy}
          >
            {action.busy ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
          </Button>
        </div>
        <ErrorBanner text={action.error} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-0 flex-1 text-xs text-muted-foreground" role="status">
            {notice || (queued ? 'Messages queue while the chat is working.' : '')}
          </span>
          {settings}
        </div>
      </div>
    </form>
  )
}

/** The model and effort the next turn uses, saved as soon as they change. */
export function TurnSettings({
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
