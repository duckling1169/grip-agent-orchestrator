import type { Family } from '@contracts/engines'
import { Blend } from 'lucide-react'
import { FamilyIcon } from '@/components/engine-icon'
import { cn } from '@/lib/utils'

const RING = cn(
  "after:absolute after:-inset-1 after:rounded-full after:border-[1.5px] after:border-transparent after:border-t-muted-foreground after:border-r-muted-foreground after:content-['']",
  'motion-safe:after:animate-spin motion-safe:after:[animation-duration:1.1s]',
  'motion-reduce:after:border-border motion-reduce:after:border-t-muted-foreground',
  'in-data-offline:after:animate-none! in-data-offline:after:border-border!',
)

export function WorkerIcon({ family, running, small }: { family: Family | 'mixed' | null; running?: boolean; small?: boolean }) {
  const size = small ? 'size-3.5' : 'size-4'
  return (
    <span className={cn('relative inline-flex size-4 flex-none items-center justify-center', small && 'size-3.5', running && RING)}>
      {family === 'mixed' ? (
        <Blend role="img" aria-label="Mixed models" className={cn(size, 'text-muted-foreground')} />
      ) : family ? (
        <FamilyIcon family={family} className={size} />
      ) : (
        <span className="size-2 rounded-full border-[1.5px] border-faint" />
      )}
    </span>
  )
}
