import { useState } from 'react'

import type { EngineQuota, UsageWindow } from '@contracts/api'
import { EngineIcon, engineName } from '@/components/engine-icon'
import { api } from '@/lib/api'
import { clockTime } from '@/lib/format'
import { errorText, textButton } from '@/lib/styles'
import { cn } from '@/lib/utils'

const CELL = 'px-1 py-1.75 text-left align-middle font-normal'
const HEAD = 'px-1 pt-0 pb-1 text-left align-bottom text-3xs font-medium text-faint'
const REMAINING = 'px-0.5 text-right whitespace-nowrap tabular-nums'

export function Quota({ quota, offline, onError }: { quota: EngineQuota[]; offline: boolean; onError: (message: string) => void }) {
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = async (entry: EngineQuota) => {
    setRefreshing(entry.engine)
    setError(null)
    try {
      await api.refreshQuota(entry.engine)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setError(message)
      onError(message)
    } finally {
      setRefreshing(null)
    }
  }
  return (
    <section className="text-xs" aria-label="Provider quota">
      <h2 className="px-1.5 pb-1.5 text-2xs font-semibold text-faint">Quota</h2>
      {error && (
        <div className={errorText} role="alert">
          {error}
        </div>
      )}
      <table className="w-full table-fixed border-collapse" aria-label="Provider quotas">
        <colgroup>
          <col />
          <col className="w-17" />
          <col className="w-8" />
          <col className="w-8" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className={HEAD}>
              Family
            </th>
            <th scope="col" className={HEAD}>
              Last checked
            </th>
            <th scope="col" className={cn(HEAD, REMAINING)}>
              5h left
            </th>
            <th scope="col" className={cn(HEAD, REMAINING)}>
              7d left
            </th>
          </tr>
        </thead>
        {quota.map(entry => {
          const name = engineName(entry.engine)
          const extraWindows = entry.windows.filter(window => window.name !== '5h' && window.name !== 'week')
          return (
            <tbody key={entry.engine}>
              <tr aria-label={`${name} quota`}>
                <th scope="row" className={cn(CELL, 'pr-0')}>
                  <div className="flex items-center gap-0.5 text-2xs">
                    <EngineIcon engine={entry.engine} className="size-3" />
                    <span
                      className={entry.error ? errorText : undefined}
                      title={entry.error ?? undefined}
                      aria-description={entry.error ?? undefined}
                    >
                      {name}
                    </span>
                  </div>
                </th>
                <td className={CELL}>
                  <div className="grid justify-items-start gap-px text-3xs leading-[1.3]">
                    <time
                      className="whitespace-nowrap"
                      dateTime={entry.checkedAt ?? undefined}
                      title={entry.checkedAt ? clockTime(entry.checkedAt) : 'never'}
                    >
                      {entry.checkedAt ? clockTime(entry.checkedAt) : 'never'}
                    </time>
                    <button
                      className={cn(textButton, 'text-3xs leading-[1.3] max-md:min-h-0')}
                      type="button"
                      disabled={offline || entry.busy || refreshing !== null}
                      onClick={() => void refresh(entry)}
                      aria-label={`Recheck ${name} quota`}
                      title={entry.engine === 'claude' ? 'Uses one small Haiku turn' : `Recheck ${name} quota`}
                    >
                      {entry.busy || refreshing === entry.engine ? 'Checking…' : 'Recheck'}
                    </button>
                  </div>
                </td>
                {['5h', 'week'].map(windowName => {
                  const window = entry.windows.find(window => window.name === windowName)
                  const label = windowName === 'week' ? '7d' : '5h'
                  return (
                    <td
                      className={cn(CELL, REMAINING, 'text-2xs')}
                      key={windowName}
                      aria-label={`${label} quota remaining`}
                      title={observation(window)}
                    >
                      {remaining(window, offline)}
                    </td>
                  )
                })}
              </tr>
              {extraWindows.length > 0 && (
                <tr>
                  <td colSpan={4} className={cn(CELL, 'text-3xs wrap-anywhere [&>span+span]:ml-2')}>
                    {extraWindows.map(window => (
                      <span key={window.name} title={observation(window)}>
                        {window.name}: {remaining(window, offline)} left
                      </span>
                    ))}
                  </td>
                </tr>
              )}
            </tbody>
          )
        })}
      </table>
      {quota.some(entry => entry.engine === 'claude') && (
        <div className="px-1 py-0.75 text-3xs text-faint">Each Claude recheck uses one small Haiku turn.</div>
      )}
    </section>
  )
}

function remaining(window: UsageWindow | undefined, offline: boolean): string {
  return offline || !window ? '—' : `${Math.round(100 - window.usedPercent)}%`
}

function observation(window: UsageWindow | undefined): string {
  if (!window) return 'No quota reading available'
  return `Resets ${window.resetsAt ? clockTime(window.resetsAt) : 'unknown'} · ${window.stale ? 'Stale reading · ' : ''}${window.observedAt ? `Observed ${clockTime(window.observedAt)}` : 'Observation time unavailable'}`
}
