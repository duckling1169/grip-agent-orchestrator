import type { Engine } from '@contracts/engines'
import { EngineIcon } from '@/components/engine-icon'
import { cn } from '@/lib/utils'

export function WorkerIcon({ engine, running, small }: { engine: Engine | null; running?: boolean; small?: boolean }) {
  return (
    <span className={cn('ico', small && 'small', running && 'running')}>
      {engine ? <EngineIcon engine={engine} className={small ? 'size-3.5' : 'size-4'} /> : <span className="blank" />}
    </span>
  )
}
