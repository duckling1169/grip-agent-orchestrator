import type { Engine, Family } from '@contracts/engines'
import { ENGINE_SPECS, FAMILY_NAMES } from '@contracts/engines'
import claude from '@/icons/claude-color.svg?raw'
import codex from '@/icons/codex-color.svg?raw'
import cursor from '@/icons/cursor.svg?raw'
import deepseek from '@/icons/deepseek-color.svg?raw'
import gemini from '@/icons/gemini-color.svg?raw'
import grok from '@/icons/grok.svg?raw'
import kimi from '@/icons/kimi-color.svg?raw'
import opencode from '@/icons/opencode.svg?raw'
import { useId } from 'react'
import { cn } from '@/lib/utils'

const ICONS: Record<Family, string> = { claude, gpt: codex, gemini, cursor, grok, opencode, kimi, deepseek }

export function engineName(engine: Engine): string {
  return ENGINE_SPECS[engine].name
}

export function EngineIcon({ engine, className }: { engine: Engine; className?: string }) {
  return <Icon svg={ICONS[ENGINE_SPECS[engine].family]} label={engineName(engine)} className={className} />
}

export function FamilyIcon({ family, className }: { family: Family; className?: string }) {
  return <Icon svg={ICONS[family]} label={FAMILY_NAMES[family]} className={className} />
}

function Icon({ svg, label, className }: { svg: string; label: string; className?: string }) {
  const id = useId().replace(/[^\w-]/g, '')
  return (
    <span
      role="img"
      aria-label={label}
      className={cn('inline-flex size-4 shrink-0 [&_svg]:size-full', className)}
      dangerouslySetInnerHTML={{ __html: svg.replaceAll('_R_0_', id) }}
    />
  )
}
