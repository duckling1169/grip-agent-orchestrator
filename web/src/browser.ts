import { useCallback, useState, useSyncExternalStore } from 'react'

/** The width at which the app shows the sidebar beside the workspace, and dialogs instead of sheets. */
export const DESKTOP = '(min-width: 768px)'

/** Whether a media query matches now, following it as the window changes. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (callback: () => void) => {
      const media = window.matchMedia(query)
      media.addEventListener('change', callback)
      // Some embedded views resize without a change event, so follow the window too.
      window.addEventListener('resize', callback)
      return () => {
        media.removeEventListener('change', callback)
        window.removeEventListener('resize', callback)
      }
    },
    [query],
  )
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches)
}

/** A stored value, or null when there is none or storage is unavailable (private mode). */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Stores a value, or removes it for null. Without storage the value lasts until the page reloads. */
export function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Storage is unavailable; the caller's state still changes for this visit.
  }
}

/**
 * State kept per browser. `parse` turns what is stored (or null) into the value; only values
 * you set are stored, so a default can still follow the screen until you choose.
 */
export function useStoredState<T>(key: string, parse: (stored: string | null) => T, format: (value: T) => string = String) {
  const [value, setValue] = useState(() => parse(readStored(key)))
  const set = (next: T) => {
    setValue(next)
    writeStored(key, format(next))
  }
  return [value, set] as const
}
