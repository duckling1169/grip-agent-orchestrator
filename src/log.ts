import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

import { now } from './clock.js'
import { isMissing } from './files.js'

export type Log = (line: string) => void

const ROTATE_AT_BYTES = 5 * 1024 * 1024

export function rotateIfLarge(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  try {
    if (statSync(path).size > ROTATE_AT_BYTES) renameSync(path, `${path}.1`)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

export function fileLog(path: string, echo: Log = line => console.log(`[moxy] ${line}`)): Log {
  rotateIfLarge(path)
  return line => {
    echo(line)
    appendBestEffort(path, `${now()} ${line}\n`)
  }
}

function appendBestEffort(path: string, text: string): void {
  try {
    appendFileSync(path, text)
  } catch {}
}
