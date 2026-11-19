import { useState } from 'react'

import type { EngineQuota, UsageWindow } from '@contracts/api'
import { EngineIcon, engineName } from '@/components/engine-icon'
import { api } from '@/lib/api'
import { clockTime } from '@/lib/format'

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
    <section className="quota" aria-label="Provider quota">
      <h2>Quota</h2>
      {error && (
        <div className="error-text" role="alert">
          {error}
        </div>
      )}
      <table className="quota-table" aria-label="Provider quotas">
        <colgroup>
          <col />
          <col className="quota-check-column" />
          <col className="quota-usage-column" />
          <col className="quota-usage-column" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Family</th>
            <th scope="col">Last checked</th>
            <th scope="col" className="quota-remaining">
              5h left
            </th>
            <th scope="col" className="quota-remaining">
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
                <th scope="row">
                  <div className="quota-family">
                    <EngineIcon engine={entry.engine} className="size-3" />
                    <span
                      className={entry.error ? 'error-text' : undefined}
                      title={entry.error ?? undefined}
                      aria-description={entry.error ?? undefined}
                    >
                      {name}
                    </span>
                  </div>
                </th>
                <td>
                  <div className="quota-check">
                    <time dateTime={entry.checkedAt ?? undefined} title={entry.checkedAt ? clockTime(entry.checkedAt) : 'never'}>
                      {entry.checkedAt ? clockTime(entry.checkedAt) : 'never'}
                    </time>
                    <button
                      className="ghost text-action"
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
                    <td className="quota-remaining" key={windowName} aria-label={`${label} quota remaining`} title={observation(window)}>
                      {remaining(window, offline)}
                    </td>
                  )
                })}
              </tr>
              {extraWindows.length > 0 && (
                <tr>
                  <td colSpan={4} className="quota-extra-windows">
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
        <div className="quota-cost faint">Each Claude recheck uses one small Haiku turn.</div>
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
