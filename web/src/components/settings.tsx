import { useState } from 'react'
import type { Snapshot } from '@contracts/api'
import type { Side } from '@/App'
import { THEMES } from '@/lib/theme'
import type { Theme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { NotificationSettings } from '@/components/notifications'

const THEME_LABELS: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' }
const SIDE_LABELS: Record<Side, string> = { left: 'Left', right: 'Right' }

export function Settings({
  snapshot,
  offline,
  theme: [theme, setTheme],
  side: [side, setSide],
}: {
  snapshot: Snapshot
  offline: boolean
  theme: readonly [Theme, (theme: Theme) => void]
  side: readonly [Side, (side: Side) => void]
}) {
  const [minutes, setMinutes] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await api.settings({ quotaRefreshMinutes: Number(minutes ?? snapshot.settings.quotaRefreshMinutes) })
      setMinutes(null)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }
  return (
    <section className="settings-page" aria-label="Settings">
      <div className="settings-inner">
        <NotificationSettings offline={offline} />
        <div>
          <h2>Quota refresh</h2>
          <div className="setting">
            <label className="name" htmlFor="quota-minutes">
              Every (minutes)
            </label>
            <input
              id="quota-minutes"
              type="number"
              min="0"
              step="1"
              max="1440"
              value={minutes ?? snapshot.settings.quotaRefreshMinutes}
              disabled={offline || saving}
              onChange={event => setMinutes(event.target.value)}
              aria-label="Quota refresh minutes"
            />
            <button
              className="ghost btn"
              type="button"
              disabled={
                offline || saving || minutes === '' || !Number.isInteger(Number(minutes)) || Number(minutes) < 0 || Number(minutes) > 1440
              }
              onClick={() => void save()}
            >
              Save quota timer
            </button>
          </div>
          <p className="note-line">
            {snapshot.settings.quotaRefreshMinutes === 0
              ? 'Automatic refresh is off.'
              : `Refreshes every ${snapshot.settings.quotaRefreshMinutes} minutes.`}{' '}
            Each Claude refresh uses one small Haiku turn. Set 0 to turn automatic refresh off.
          </p>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </div>
        <div>
          <h2>Appearance</h2>
          <div className="setting">
            <span className="name">Theme</span>
            <Segmented label="Theme" options={THEMES} labels={THEME_LABELS} value={theme} onChange={setTheme} />
          </div>
          <div className="setting">
            <span className="name">Tasks column</span>
            <Segmented label="Tasks column" options={['left', 'right'] as const} labels={SIDE_LABELS} value={side} onChange={setSide} />
          </div>
        </div>
        <div>
          <h2>About</h2>
          <div className="setting">
            <span className="name">Machine</span>
            <span className="mono faint">{snapshot.host}</span>
          </div>
          <div className="setting">
            <span className="name">Signed in as</span>
            <span className="faint">{snapshot.login}</span>
          </div>
        </div>
      </div>
    </section>
  )
}

function Segmented<T extends string>({
  label,
  options,
  labels,
  value,
  onChange,
}: {
  label: string
  options: readonly T[]
  labels: Record<T, string>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(option => (
        <button
          key={option}
          className={cn('ghost', option === value && 'on')}
          type="button"
          role="radio"
          aria-checked={option === value}
          onClick={() => onChange(option)}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  )
}
