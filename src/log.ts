import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/** Past this size, the log moves to `grip.log.1` when Grip starts, replacing the one before. */
const KEEP_BYTES = 5 * 1024 * 1024

/**
 * Grip's log: each line to the console, and with a time to `~/.grip/logs/grip.log`, since the
 * logon task has no console anyone sees. Writes are synchronous so the last lines before a
 * crash or shutdown are kept.
 */
export function gripLogger(path: string, write: (line: string) => void = line => console.log(line)) {
  mkdirSync(dirname(path), { recursive: true })
  try {
    if (statSync(path).size > KEEP_BYTES) renameSync(path, `${path}.1`)
  } catch {
    // No log yet.
  }
  return (line: string) => {
    write(`[grip] ${line}`)
    try {
      appendFileSync(path, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // A full or locked disk must not stop Grip.
    }
  }
}
