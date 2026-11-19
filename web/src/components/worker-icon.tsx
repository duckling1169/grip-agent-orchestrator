import type { Engine } from '@contracts/engines'
import { EngineIcon } from '@/components/engine-icon'
import { cn } from '@/lib/utils'

const RING = cn(
  "after:absolute after:-inset-1 after:rounded-full after:border-[1.5px] after:border-transparent after:border-t-muted-foreground after:border-r-muted-foreground after:content-['']",
  'motion-safe:after:animate-spin motion-safe:after:[animation-duration:1.1s]',
  'motion-reduce:after:border-border motion-reduce:after:border-t-muted-foreground',
  'in-data-offline:after:animate-none! in-data-offline:after:border-border!',
)

export function WorkerIcon({ engine, running, small }: { engine: Engine | null; running?: boolean; small?: boolean }) {
  return (
    <span className={cn('relative inline-flex size-4 flex-none items-center justify-center', small && 'size-3.5', running && RING)}>
      {engine ? (
        <EngineIcon engine={engine} className={small ? 'size-3.5' : 'size-4'} />
      ) : (
        <span className="size-2 rounded-full border-[1.5px] border-faint" />
      )}
    </span>
  )
}
