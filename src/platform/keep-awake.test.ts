import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import type { SpawnPiped } from '../exec.js'
import { KeepAwake, keepAwakeCommand } from './keep-awake.js'

function fakeHelper() {
  const spawned: { command: string; killed: boolean; stdinEnded: boolean }[] = []
  const spawn: SpawnPiped = command => {
    const record = { command, killed: false, stdinEnded: false }
    spawned.push(record)
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough().on('finish', () => (record.stdinEnded = true)),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => (record.killed = true),
    })
    return child as unknown as ChildProcessWithoutNullStreams
  }
  return { spawn, spawned }
}

describe('keep-awake', () => {
  it('holds one helper while work runs and ends it when work stops', async () => {
    const { spawn, spawned } = fakeHelper()
    const awake = new KeepAwake({ command: { command: 'hold', args: [] }, spawn })
    awake.set(true)
    awake.set(true)
    expect(spawned).toHaveLength(1)
    expect(awake.holding).toBe(true)
    awake.set(false)
    await new Promise(resolve => setImmediate(resolve))
    expect(spawned[0]).toMatchObject({ killed: true, stdinEnded: true })
    expect(awake.holding).toBe(false)
  })

  it('does nothing where the platform has no keep-awake command', () => {
    const { spawn, spawned } = fakeHelper()
    new KeepAwake({ command: null, spawn }).set(true)
    expect(spawned).toHaveLength(0)
    expect(keepAwakeCommand('linux')).toBeNull()
    expect(keepAwakeCommand('win32')?.command).toBe('powershell.exe')
  })
})
