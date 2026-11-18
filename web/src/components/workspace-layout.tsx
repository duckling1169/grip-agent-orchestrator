import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'

import type { Engine } from '../types.js'
import { EngineMark, ErrorBanner, touchButton } from './common.js'

export const contentWidth = 'mx-auto w-full max-w-4xl px-4 sm:px-6 lg:px-8'

export const composerFrame = 'shrink-0 border-t bg-background pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]'

// Keep Radix's intrinsic-width wrapper from expanding the viewport for code blocks and diffs.
export const scrollFrame = 'min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!'

export const viewportSelector = '[data-slot="scroll-area-viewport"]'

export const pathText = 'font-mono text-xs wrap-anywhere'

export const textLink = 'font-medium underline-offset-4 hover:underline focus-visible:underline'

export function LoadNotice({ loading, error, retry }: { loading: boolean; error?: string; retry: () => void }) {
  if (!error && !loading) return null
  return (
    <div className="grid justify-items-start gap-2 text-sm text-muted-foreground">
      <ErrorBanner text={error} />
      {error ? (
        <Button className={touchButton} variant="outline" size="sm" type="button" onClick={retry}>
          Try again
        </Button>
      ) : (
        <p role="status">Loading…</p>
      )}
    </div>
  )
}

export function WorkspaceHeader({
  backHref = '#/',
  backLabel = 'Chats',
  title,
  engine,
  details,
  actions,
}: {
  backHref?: string
  backLabel?: string
  title: string
  engine?: Engine
  details?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3 sm:px-6 lg:px-8">
      <div className="w-full md:hidden">
        <Button variant="ghost" size="sm" className={`-ml-2 ${touchButton}`} asChild>
          <a href={backHref}>
            <ArrowLeft aria-hidden="true" />
            {backLabel}
          </a>
        </Button>
      </div>
      <div className="min-w-0 flex-[1_1_12rem]">
        <h1 className="flex items-baseline gap-2 text-lg font-semibold tracking-tight sm:text-xl">
          {engine && <EngineMark engine={engine} />}
          <span className="min-w-0 wrap-anywhere">{title}</span>
        </h1>
        {details && <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">{details}</div>}
      </div>
      {actions && <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">{actions}</div>}
    </header>
  )
}
