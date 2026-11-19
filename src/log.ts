import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export type Log = (line: string) => void

const ROTATE_AT_BYTES = 5 * 1024 * 1024

export function rotateIfLarge(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  try {
    if (statSync(path).size > ROTATE_AT_BYTES) renameSync(path, `${path}.1`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export function fileLog(path: string, echo: Log = line => console.log(`[moxy] ${line}`)): Log {
  rotateIfLarge(path)
  return line => {
    echo(line)
    appendBestEffort(path, `${new Date().toISOString()} ${line}\n`)
  }
}

function appendBestEffort(path: string, text: string): void {
  try {
    appendFileSync(path, text)
  } catch {}
}
