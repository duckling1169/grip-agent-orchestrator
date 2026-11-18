import type { ComponentChildren } from 'preact'
import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

import { agoText, durationText, minutesBetween } from '../../../src/quota/usage.js'
import { errorText } from '../api.js'
import type { Engine, RunSummary } from '../types.js'

export const engines: Engine[] = ['claude', 'codex', 'agy']
export const engineNames: Record<Engine, string> = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' }
const engineMarks: Record<Engine, string> = { claude: '✻', codex: '◆', agy: '▲' }

export function isEngine(value: string): value is Engine {
  return engines.some(engine => engine === value)
}

export function EngineMark({ engine, labelled = false }: { engine: Engine; labelled?: boolean }) {
  return (
    <span class={`engine-mark engine-${engine}`} title={engineNames[engine]} aria-hidden={labelled ? undefined : true}>
      {engineMarks[engine]}
      {labelled && <span class="engine-name">{engineNames[engine]}</span>}
    </span>
  )
}

export function StatusDot({ status, engine }: { status: string; engine?: Engine | null }) {
  return <span class={`status-dot status-${status}${engine ? ` engine-${engine}` : ''}`} aria-hidden="true" />
}

export function runActivity(run: RunSummary, now: number, concise = false): string {
  if (run.status === 'running') {
    const elapsed = run.turns <= 1 ? durationText(minutesBetween(run.createdAt, now) ?? 0) : ''
    return concise ? 'Working' : `Turn ${Math.max(run.turns, 1)} working${elapsed ? ` · ${elapsed}` : ''}`
  }
  const label = { done: 'Done', failed: 'Failed', stopped: 'Stopped' }[run.status]
  return !concise && run.finishedAt ? `${label} ${agoText(run.finishedAt, now)}` : label
}

export function folderName(path: string | null | undefined) {
  return path?.split(/[\\/]/).filter(Boolean).at(-1) ?? path ?? ''
}

export function Time({ at }: { at: string }) {
  const date = new Date(at)
  return (
    <time dateTime={at} title={date.toLocaleString()}>
      {date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
    </time>
  )
}

export function Markdown({ text }: { text: string }) {
  const html = useMemo(
    () =>
      DOMPurify.sanitize(marked.parse(text, { async: false }), {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['img', 'picture', 'video', 'audio', 'source', 'form', 'style'],
        FORBID_ATTR: ['style'],
        SANITIZE_NAMED_PROPS: true,
      }),
    [text],
  )
  return <div class="markdown" dangerouslySetInnerHTML={{ __html: html }} />
}

export function ErrorBanner({ text }: { text?: string | null }) {
  return text ? (
    <p class="error-banner" role="alert">
      {text}
    </p>
  ) : null
}

export function useAction() {
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function perform(work: () => Promise<void>) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(undefined)
    try {
      await work()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return { busy, error, perform }
}

export function Dialog({
  title,
  busy = false,
  close,
  children,
}: {
  title: string
  busy?: boolean
  close: () => void
  children: ComponentChildren
}) {
  const id = useId()
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const opener = document.activeElement
    const dialog = ref.current
    dialog?.showModal()
    return () => {
      dialog?.close()
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])
  return (
    <dialog
      ref={ref}
      class="modal"
      aria-labelledby={id}
      onCancel={event => {
        event.preventDefault()
        if (!busy) close()
      }}
    >
      <div class="modal-header">
        <h2 id={id}>{title}</h2>
        <button type="button" class="icon-button" aria-label="Close dialog" disabled={busy} onClick={close}>
          ×
        </button>
      </div>
      {children}
    </dialog>
  )
}
