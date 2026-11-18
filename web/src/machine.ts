import { readStored, writeStored } from './browser.js'

/**
 * Which machine's Grip the app shows (DESIGN §12). The page always comes from the machine it was
 * installed from; API calls and the event stream go to the chosen machine's address. Null means
 * the machine that served the page.
 */
const KEY = 'grip.machine'

/** The chosen base as an origin, or null when it is this page's own origin or unreadable. */
export function normalizeBase(value: string | null | undefined, here: string): string | null {
  if (!value) return null
  try {
    const origin = new URL(value).origin
    return origin === 'null' || origin === here ? null : origin
  } catch {
    return null
  }
}

/** A request path on the chosen machine. */
export function apiUrl(path: string, base: string | null): string {
  return base ? new URL(path, base).toString() : path
}

// Without storage (private mode) the app shows this machine.
const stored = readStored(KEY)
let current = stored ? normalizeBase(stored, location.origin) : null

export const machineBase = () => current

export function chooseMachine(url: string | null): string | null {
  current = normalizeBase(url, location.origin)
  writeStored(KEY, current)
  return current
}

/** A short name for a base, for messages before that machine has answered. */
export function baseName(base: string): string {
  try {
    return new URL(base).hostname.split('.')[0] || base
  } catch {
    return base
  }
}
