import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

import { agoText, durationText, minutesBetween } from '../../../src/quota/usage.js'
import { api } from '../api.js'
import { useMediaQuery } from '../browser.js'
import { chatHref, runHref, useDetail } from '../state.js'
import type { AppState, RunDetail, RunSummary } from '../types.js'
import { CopyButton, ErrorBanner, folderName, Markdown, runActivity, StatusDot, Time, touchButton, useCopy } from './common.js'
import { Composer, TurnSettings } from './composer.js'
import { AgentLine, DetailsColumn, Fact, Facts, WIDE, WorkerSection } from './details.js'
import { contentWidth, LoadNotice, pathText, scrollFrame, textLink, WorkspaceHeader } from './workspace-layout.js'

function Diff({ diff }: { diff: NonNullable<RunDetail['diff']> }) {
  const sections = diff.patch.split(/(?=^diff --git )/m).filter(Boolean)
  return (
    <WorkerSection title="Diff">
      {diff.stat && <pre className="min-w-0 overflow-x-auto rounded-md border bg-muted/50 p-3 text-xs">{diff.stat}</pre>}
      {sections.map((section, index) => {
        const file = section.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? section.match(/^--- a\/(.+)$/m)?.[1] ?? section.split('\n')[0] ?? 'Patch'
        return (
          <details className="min-w-0 overflow-hidden rounded-md border" key={`${file}-${index}`}>
            <summary className="cursor-pointer px-3 py-2 font-mono text-xs wrap-anywhere hover:bg-muted focus-visible:bg-muted">
              {file}
            </summary>
            <pre className="overflow-x-auto border-t bg-muted/30 py-2 text-xs leading-relaxed">
              {section.split('\n').map((line, row) => {
                const tone =
                  line.startsWith('+') && !line.startsWith('+++')
                    ? 'bg-muted font-medium'
                    : line.startsWith('-') && !line.startsWith('---')
                      ? 'bg-destructive/10 text-destructive'
                      : ''
                return (
                  <span key={row} className={tone}>
                    {line}
                    {'\n'}
                  </span>
                )
              })}
            </pre>
          </details>
        )
      })}
      {diff.untrackedFiles.length > 0 && <p className="text-sm text-muted-foreground">Untracked: {diff.untrackedFiles.join(', ')}</p>}
      {diff.truncated && <p className="text-sm text-muted-foreground">Grip shortened this patch.</p>}
      {!sections.length && !diff.untrackedFiles.length && <p className="text-sm text-muted-foreground">No changes.</p>}
    </WorkerSection>
  )
}

function RunOutput({ run, now }: { run: RunDetail; now: number }) {
  return (
    <>
      <WorkerSection title="Brief">
        {'path' in run.brief ? <code className={pathText}>{run.brief.path}</code> : <Markdown text={run.brief.text} />}
      </WorkerSection>
      <WorkerSection title="Turns">
        {run.turns.length ? (
          <ol className="grid min-w-0 divide-y">
            {run.turns.map(turn => (
              <li key={turn.turn} className="grid min-w-0 gap-3 py-4 first:pt-0 last:pb-0">
                <h3 className="flex items-center gap-1 text-sm font-medium">
                  {turn.output && <CopyButton text={turn.output} label={`Copy turn ${turn.turn} output`} className="order-last ml-auto" />}
                  Turn {turn.turn}{' '}
                  <span className="font-normal text-muted-foreground">
                    · {turn.from === 'user' ? 'You' : turn.turn === 1 ? 'Original brief' : 'Orchestrator'}
                  </span>
                </h3>
                {turn.message && (
                  <div className="min-w-0 rounded-md bg-muted/50 p-3">
                    <Markdown text={turn.message} />
                  </div>
                )}
                {turn.output ? <Markdown text={turn.output} /> : <p className="text-sm text-muted-foreground">No output recorded.</p>}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">No turns recorded yet.</p>
        )}
      </WorkerSection>
      {run.diff && <Diff diff={run.diff} />}
    </>
  )
}

/** What the worker changed so far, beside its output on wide screens. */
function RunGit({ run, now }: { run: RunDetail; now: number }) {
  return (
    <>
      {run.overlaps.length > 0 && (
        <WorkerSection title="Overlapping changes">
          <ul className="grid gap-2 text-sm text-muted-foreground">
            {run.overlaps.map(overlap => (
              <li key={overlap.runId}>
                <a className={textLink} href={runHref(overlap.runId)}>
                  {overlap.title}
                </a>{' '}
                · {overlap.files.join(', ')}
              </li>
            ))}
          </ul>
        </WorkerSection>
      )}
      {run.git && (
        <WorkerSection title="Git">
          <Facts>
            <Fact name="Commits ahead">{run.git.ahead}</Fact>
            <Fact name="Files changed">{run.git.changedFiles.length}</Fact>
            {run.git.lastCommit && (
              <Fact name="Last commit">
                {run.git.lastCommit.subject} · {agoText(run.git.lastCommit.at, now)}
              </Fact>
            )}
            {run.git.newestEdit && (
              <Fact name="Last edit">
                {run.git.newestEdit.file} · {agoText(run.git.newestEdit.at, now)}
              </Fact>
            )}
          </Facts>
          {run.git.changedFiles.length > 0 && (
            <ul className="grid gap-1">
              {run.git.changedFiles.map(file => (
                <li key={file}>
                  <code className={pathText}>{file}</code>
                </li>
              ))}
            </ul>
          )}
        </WorkerSection>
      )}
    </>
  )
}

export function RunWorkspace({
  id,
  live,
  state,
  now,
  offline,
  focus,
  stop,
  retry,
}: {
  id: string
  live?: RunSummary
  state: AppState | null
  now: number
  offline: boolean
  focus?: number
  stop: (run: RunSummary) => void
  retry: (run: RunSummary) => void
}) {
  const detail = useDetail(id, api.run, live)
  const wide = useMediaQuery(WIDE)
  const copy = useCopy()
  const run = live ?? (detail.data && { ...detail.data, turns: detail.data.turns.length })
  if (!run)
    return (
      <>
        <WorkspaceHeader title="Worker" />
        <div className={`${contentWidth} py-4`}>
          <LoadNotice loading={!detail.error} error={detail.error} retry={detail.refresh} />
        </div>
      </>
    )

  const owner = state?.chats.find(chat => chat.id === run.chatId)
  const back = run.chatId ? chatHref(run.chatId) : '#/'
  const active = run.status === 'running'
  const ended = run.finishedAt ? Date.parse(run.finishedAt) : now
  const elapsed = durationText(minutesBetween(run.createdAt, ended) ?? 0)
  const facts = (
    <>
      <WorkerSection title="Worker details">
        <Facts>
          <Fact name="Agent" wide>
            <AgentLine engine={run.engine} model={run.model} />
          </Fact>
          {detail.data?.effort && <Fact name="Effort">{detail.data.effort}</Fact>}
          <Fact name="Chat">
            {run.chatId ? (
              <a className={textLink} href={back}>
                {owner?.title ?? 'Chat'}
              </a>
            ) : (
              'Independent worker'
            )}
          </Fact>
          <Fact name="Started">
            <Time at={run.createdAt} full />
          </Fact>
          <Fact name="Elapsed">{elapsed}</Fact>
          <Fact name="Turns started">{run.turns}</Fact>
          <Fact name="Folder" wide>
            <code className={pathText}>{run.folder}</code>
          </Fact>
          {run.worktree && (
            <Fact name="Worktree" wide>
              <code className={pathText}>{run.worktree}</code>
            </Fact>
          )}
          {run.branch && (
            <Fact name="Branch" wide>
              <code className={pathText}>{run.branch}</code>
            </Fact>
          )}
        </Facts>
      </WorkerSection>
      {detail.data && <RunGit run={detail.data} now={now} />}
    </>
  )
  return (
    <>
      <WorkspaceHeader
        backHref={back}
        backLabel={run.chatId ? 'Chat' : 'Chats'}
        title={run.title}
        engine={run.engine}
        details={
          <>
            <span className="inline-flex items-center gap-1.5">
              <StatusDot status={run.status} engine={run.engine} />
              {runActivity(run, now)}
            </span>
            <span className="min-w-0 wrap-anywhere" title={run.worktree ?? run.folder}>
              {folderName(run.worktree ?? run.folder)}
            </span>
          </>
        }
        actions={
          <>
            <Button className={touchButton} variant="outline" size="sm" type="button" onClick={() => copy.copy(run.worktree ?? run.folder)}>
              {copy.copied ? 'Path copied' : 'Copy folder path'}
            </Button>
            {active ? (
              <Button className={touchButton} variant="outline" size="sm" type="button" disabled={offline} onClick={() => stop(run)}>
                Stop worker
              </Button>
            ) : (
              <Button className={touchButton} variant="outline" size="sm" type="button" disabled={offline} onClick={() => retry(run)}>
                Retry with another agent
              </Button>
            )}
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ScrollArea className={scrollFrame}>
            <div className={`${contentWidth} grid min-w-0 gap-5 pt-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:pt-6`}>
              <ErrorBanner text={run.error} />
              <ErrorBanner text={copy.error} />
              {!wide && facts}
              <LoadNotice loading={!detail.data && !detail.error} error={detail.error} retry={detail.refresh} />
              {detail.data && <RunOutput run={detail.data} now={now} />}
            </div>
          </ScrollArea>
          {!active && (
            <Composer
              name="Message worker"
              blocked={offline}
              settings={
                <TurnSettings
                  engine={run.engine}
                  model={run.model}
                  effort={run.effort ?? null}
                  disabled={offline}
                  save={settings => api.runSettings(id, settings)}
                />
              }
              focus={focus}
              send={async text => {
                await api.messageRun(id, text)
                detail.refresh()
              }}
            />
          )}
        </div>
        {wide && <DetailsColumn label="Worker details">{facts}</DetailsColumn>}
      </div>
    </>
  )
}
