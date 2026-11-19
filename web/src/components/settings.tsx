import type { Snapshot } from '@contracts/api'
import type { Side } from '@/App'
import { THEMES } from '@/lib/theme'
import type { Theme } from '@/lib/theme'
import { cn } from '@/lib/utils'

const THEME_LABELS: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' }
const SIDE_LABELS: Record<Side, string> = { left: 'Left', right: 'Right' }

export function Settings({
  snapshot,
  theme: [theme, setTheme],
  side: [side, setSide],
}: {
  snapshot: Snapshot
  theme: readonly [Theme, (theme: Theme) => void]
  side: readonly [Side, (side: Side) => void]
}) {
  return (
    <section className="settings-page" aria-label="Settings">
      <div className="settings-inner">
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
