import type { RowTone } from '@/lib/status'
import { cn } from '@/lib/utils'

export const ghost =
  'inline-flex min-h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground disabled:cursor-not-allowed disabled:bg-transparent disabled:opacity-45 max-md:min-h-9'

export const outlineButton = cn(ghost, 'border bg-popover px-2.5 text-xs')

export const linkButton = cn(ghost, 'min-h-0 p-0 text-xs underline underline-offset-2 hover:bg-transparent')

export const textButton = cn(ghost, 'min-h-0 p-0 text-xs font-medium text-muted-foreground hover:bg-transparent hover:text-foreground')

export const iconButton = cn(ghost, 'min-h-0 p-0.75 text-faint hover:text-foreground')

export const meta = 'flex flex-wrap items-center gap-2 text-xs text-muted-foreground'

export const fieldLabel = 'mb-1 text-2xs font-semibold text-faint'

export const note = 'text-xs text-faint'

export const errorText = 'whitespace-pre-wrap text-destructive'

export const working = 'flex items-center gap-2 text-xs text-muted-foreground'

export const readingColumn = 'mx-auto w-full max-w-180'

export const composerGutter = 'px-7 max-md:px-3'

export const settingHeading = 'mb-1.5 text-xs font-semibold text-faint'

export const settingRow = 'flex min-h-11 flex-wrap items-center gap-2.5 border-b last:border-b-0'

export const field = 'min-w-0 rounded-md border bg-popover text-foreground placeholder:text-faint'

const TONES: Record<RowTone, string> = {
  failed: 'bg-destructive/5 inset-ring inset-ring-destructive hover:bg-destructive/5 dark:bg-destructive/8 dark:hover:bg-destructive/8',
  stopped: 'bg-faint/6 inset-ring inset-ring-faint hover:bg-faint/6 dark:bg-faint/8 dark:hover:bg-faint/8',
}

export function row(tone: RowTone | null, selected = false): string {
  return cn(ghost, 'w-full min-h-7.5 gap-2 px-2 py-1.25 max-md:min-h-11', tone ? TONES[tone] : selected && 'bg-accent')
}

export const rowLabel = 'min-w-0 flex-1 truncate'

export const rowAside = 'flex-none whitespace-nowrap text-xs text-faint'

export const rows = 'mt-0.5 mb-2.5 flex flex-col gap-0.5'

export const mono = 'font-mono text-xs'
