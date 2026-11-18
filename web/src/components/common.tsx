import { useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

import { agoText, durationText, minutesBetween } from '../../../src/quota/usage.js'
import { errorText } from '../api.js'
import type { Engine, RunSummary } from '../types.js'

export const engines: Engine[] = ['claude', 'codex', 'agy']
export const engineNames: Record<Engine, string> = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' }
const engineMarks: Record<Engine, string> = { claude: '✻', codex: '◆', agy: '▲' }
export const engineColors: Record<Engine, string> = { claude: 'text-claude', codex: 'text-codex', agy: 'text-agy' }

export function isEngine(value: string): value is Engine {
  return engines.some(engine => engine === value)
}

export function EngineMark({ engine, labelled = false }: { engine: Engine; labelled?: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 ${engineColors[engine]}`}
      title={engineNames[engine]}
      aria-hidden={labelled ? undefined : true}
    >
      {engineMarks[engine]}
      {labelled && <span className="text-foreground">{engineNames[engine]}</span>}
    </span>
  )
}

export function StatusDot({ status, engine }: { status: string; engine?: Engine | null }) {
  const working = status === 'working' || status === 'running'
  const color =
    working && engine ? engineColors[engine] : status === 'failed' || status === 'offline' ? 'text-destructive' : 'text-muted-foreground'
  return (
    <span
      className={`inline-block size-1.5 shrink-0 rounded-full bg-current ${color} ${working ? 'motion-safe:animate-pulse' : ''}`}
      aria-hidden="true"
    />
  )
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
  return (
    <div
      className="min-w-0 space-y-3 text-sm leading-relaxed wrap-anywhere [&_a]:underline [&_a]:underline-offset-4 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2 [&_ul]:list-disc [&_ul]:pl-5"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export function ErrorBanner({ text }: { text?: string | null }) {
  return text ? (
    <p className="rounded-md border border-destructive/30 p-3 text-sm text-destructive wrap-anywhere" role="alert">
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
