import { useState } from 'react'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    return
  }
}

export function useStoredState<T>(key: string, parse: (stored: string | null) => T, format: (value: T) => string = String) {
  const storageKey = `moxy:${key}`
  const [value, setValue] = useState(() => parse(read(storageKey)))
  const set = (next: T) => {
    setValue(next)
    write(storageKey, format(next))
  }
  return [value, set] as const
}

export function useStoredFlag(key: string, initial: boolean) {
  return useStoredState(key, stored => (stored === null ? initial : stored === 'true'))
}
