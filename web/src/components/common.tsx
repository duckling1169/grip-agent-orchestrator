import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

import { agoText, durationText, minutesBetween } from '../../../src/quota/usage.js'
import { errorText } from '../api.js'
import type { ChatSummary, Engine, RunSummary } from '../types.js'

/** Buttons at least 44 px tall on touch screens, compact with a mouse. */
export const touchButton = 'min-h-11 md:min-h-8'
/** The keyboard focus ring for rows and links that fill their space. */
export const focusRing = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring'

export const engines: Engine[] = ['claude', 'codex', 'agy']
// Model families, not product names: Codex runs GPT models and Antigravity runs Gemini.
export const engineNames: Record<Engine, string> = { claude: 'Claude', codex: 'GPT', agy: 'Gemini' }
const engineMarks: Record<Engine, string> = { claude: '✻', codex: '◆', agy: '▲' }
export const engineColors: Record<Engine, string> = { claude: 'text-claude', codex: 'text-codex', agy: 'text-agy' }

export function isEngine(value: string): value is Engine {
  return engines.some(engine => engine === value)
}

/** What an agent's icon shows on its own: a medium blink while working, a slow one while waiting. */
export type MarkStatus = 'working' | 'waiting' | 'failed' | 'stopped' | 'idle'

const markLooks: Record<MarkStatus, string> = {
  working: 'motion-safe:animate-blink',
  waiting: 'motion-safe:animate-blink-slow',
  failed: 'text-destructive',
  stopped: 'opacity-50',
  idle: '',
}

export function EngineMark({
  engine,
  labelled = false,
  status,
  statusLabel,
}: {
  engine: Engine
  labelled?: boolean
  status?: MarkStatus
  /** Said by screen readers and on hover when the icon alone carries the status. */
  statusLabel?: string
}) {
  const color = status === 'failed' ? '' : engineColors[engine]
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 ${color} ${status ? markLooks[status] : ''}`}
      title={statusLabel ? `${engineNames[engine]}: ${statusLabel}` : engineNames[engine]}
      {...(statusLabel
        ? { role: 'img', 'aria-label': `${engineNames[engine]}, ${statusLabel}` }
        : { 'aria-hidden': labelled ? undefined : true })}
    >
      {engineMarks[engine]}
      {/* With motion turned off nothing blinks, so a dot says working and a ring says waiting. */}
      {status === 'working' && <span className="hidden size-1.5 rounded-full bg-current motion-reduce:inline-block" aria-hidden="true" />}
      {status === 'waiting' && (
        <span className="hidden size-1.5 rounded-full border border-current motion-reduce:inline-block" aria-hidden="true" />
      )}
      {labelled && <span className="text-foreground">{engineNames[engine]}</span>}
    </span>
  )
}

export function runMark(run: RunSummary): MarkStatus {
  return run.status === 'running' ? 'working' : run.status === 'done' ? 'idle' : run.status
}

export function chatMark(chat: ChatSummary): MarkStatus {
  if (chat.waiting) return 'waiting'
  return chat.status === 'working' ? 'working' : chat.status === 'failed' || chat.status === 'stopped' ? chat.status : 'idle'
}

export function hostName(host: string | null) {
  return host === 'claude-code' ? 'Claude Code' : host || 'its MCP host'
}

export function chatStatusText(chat: ChatSummary) {
  if (chat.waiting) return 'Waiting on workers'
  return chat.kind === 'external'
    ? hostName(chat.host)
    : { working: 'Working', idle: 'Ready', failed: 'Failed', stopped: 'Stopped' }[chat.status]
}

export function ChatStatus({ chat }: { chat: ChatSummary }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 wrap-anywhere">
      <StatusDot status={chat.waiting ? 'waiting' : chat.status} engine={chat.engine} />
      {chatStatusText(chat)}
    </span>
  )
}

export function StatusDot({ status, engine }: { status: string; engine?: Engine | null }) {
  const working = status === 'working' || status === 'running'
  const color =
    working && engine
      ? engineColors[engine]
      : status === 'online'
        ? 'text-emerald-500'
        : status === 'failed' || status === 'offline'
          ? 'text-destructive'
          : 'text-muted-foreground'
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

/** A time of day with the full date on hover, or with `full` the date and time written out. */
export function Time({ at, full = false, className }: { at: string; full?: boolean; className?: string }) {
  const date = new Date(at)
  return (
    <time className={className} dateTime={at} title={full ? undefined : date.toLocaleString()}>
      {full ? date.toLocaleString() : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
    </time>
  )
}

/** Copies text to the clipboard; `copied` stays true for a moment after, to show it worked. */
export function useCopy() {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = (text: string) => {
    setError(undefined)
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      (failure: unknown) => setError(errorText(failure)),
    )
  }
  return { copied, error, copy }
}

/** Copies a message's text as written (its Markdown), and shows a tick for a moment after. */
export function CopyButton({ text, label = 'Copy message', className = '' }: { text: string; label?: string; className?: string }) {
  const { copied, copy } = useCopy()
  return (
    <button
      type="button"
      className={`relative inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground after:absolute after:-inset-2.5 hover:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-ring md:after:inset-0 ${className}`}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      onClick={() => copy(text)}
    >
      {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
    </button>
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
