import type { ReactNode } from 'react'

import { ScrollArea } from '@/components/ui/scroll-area'

import { runHref } from '../state.js'
import type { ChatSummary, Engine } from '../types.js'
import { EngineMark, focusRing, hostName, runActivity, runMark, Time } from './common.js'
import { useModelChoices } from './model-fields.js'
import { ResizeHandle, useColumnWidth } from './resize-handle.js'
import { pathText, scrollFrame } from './workspace-layout.js'

export function WorkerSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid min-w-0 gap-3 border-b pb-5 wrap-anywhere last:border-b-0 last:pb-0">
      <h2 className="font-medium">{title}</h2>
      {children}
    </section>
  )
}

export function Facts({ children }: { children: ReactNode }) {
  return <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 text-sm wrap-anywhere sm:gap-x-6">{children}</dl>
}

export function Fact({ name, wide = false, children }: { name: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`min-w-0 ${wide ? 'col-span-2' : ''}`}>
      <dt className="mb-0.5 text-xs text-muted-foreground">{name}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/**
 * The third column on wide screens: details beside the conversation or output, so the middle
 * holds only what you read and write. Drag its left edge to resize it.
 */
export function DetailsColumn({ label, children }: { label: string; children: ReactNode }) {
  const column = useColumnWidth('details', 320, 260, 560)
  return (
    <aside aria-label={label} className="relative hidden min-h-0 shrink-0 flex-col border-l xl:flex" style={{ width: column.width }}>
      <ResizeHandle column={column} edge="left" label="Resize the details column" />
      <ScrollArea className={scrollFrame}>
        <div className="grid min-w-0 gap-5 px-5 py-5">{children}</div>
      </ScrollArea>
    </aside>
  )
}

export const WIDE = '(min-width: 1280px)'

export function ChatDetails({ chat, now }: { chat: ChatSummary; now: number }) {
  return (
    <>
      <WorkerSection title={`Workers (${chat.runs.length})`}>
        {chat.runs.length ? (
          <ul className="-mx-2 grid min-w-0 gap-0.5">
            {chat.runs.map(run => (
              <li key={run.id} className="min-w-0">
                <a href={runHref(run.id)} className={`flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent ${focusRing}`}>
                  <EngineMark engine={run.engine} status={runMark(run)} statusLabel={runActivity(run, now)} />
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate text-sm font-medium" title={run.title}>
                      {run.title}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">{runActivity(run, now)}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No workers yet.</p>
        )}
      </WorkerSection>
      <WorkerSection title="Chat details">
        <Facts>
          <Fact name="Agent" wide>
            {chat.kind === 'external' ? hostName(chat.host) : <AgentLine engine={chat.engine ?? 'claude'} model={chat.model} />}
          </Fact>
          {chat.effort && <Fact name="Effort">{chat.effort}</Fact>}
          <Fact name="Started">
            <Time at={chat.createdAt} full />
          </Fact>
          <Fact name="Turns">{chat.turns}</Fact>
          {chat.folder && (
            <Fact name="Folder" wide>
              <code className={pathText}>{chat.folder}</code>
            </Fact>
          )}
        </Facts>
      </WorkerSection>
    </>
  )
}

/**
 * A model by its catalog name. With none chosen the agent picks its own default, which Claw
 * does not report back, so say so rather than guess.
 */
function ModelName({ engine, model }: { engine: Engine; model: string | null }) {
  const { chosen } = useModelChoices(engine, model ?? '', '')
  if (!model) return <span className="text-muted-foreground">agent's default model</span>
  return <span title={model}>{chosen?.label ?? model}</span>
}

/** The agent and its model, as the details columns show them. */
export function AgentLine({ engine, model }: { engine: Engine; model: string | null }) {
  return (
    <>
      <EngineMark engine={engine} labelled />
      {' · '}
      <ModelName engine={engine} model={model} />
    </>
  )
}
