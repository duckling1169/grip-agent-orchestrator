import type { Engine } from '@contracts/engines'
import { ENGINE_SPECS } from '@contracts/engines'
import claude from '@/icons/claude-color.svg?raw'
import codex from '@/icons/codex-color.svg?raw'
import cursor from '@/icons/cursor.svg?raw'
import deepseek from '@/icons/deepseek-color.svg?raw'
import gemini from '@/icons/gemini-color.svg?raw'
import grok from '@/icons/grok.svg?raw'
import kimi from '@/icons/kimi-color.svg?raw'
import opencode from '@/icons/opencode.svg?raw'
import { cn } from '@/lib/utils'

const ICONS: Record<Engine, string> = { claude, codex, agy: gemini, cursor, grok, opencode, kimi, deepseek }

export function engineName(engine: Engine): string {
  return ENGINE_SPECS[engine].name
}

export function EngineIcon({ engine, className }: { engine: Engine; className?: string }) {
  return (
    <span
      role="img"
      aria-label={engineName(engine)}
      className={cn('inline-flex size-4 shrink-0 [&_svg]:size-full', className)}
      dangerouslySetInnerHTML={{ __html: ICONS[engine] }}
    />
  )
}
