import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import type { Exec, SpawnPiped } from '../exec.js'
import { isElevated } from './elevation.js'
import { KeepAwake, keepAwakeCommand } from './keep-awake.js'

/** A child process that records how it was ended. */
class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  stdinEnded = false
  constructor() {
    super()
    this.stdin.on('finish', () => (this.stdinEnded = true))
  }
  kill() {
    this.killed = true
    this.emit('exit', null, 'SIGTERM')
    return true
  }
}

function fakeSpawn() {
  const children: FakeChild[] = []
  const calls: string[][] = []
  const spawn: SpawnPiped = (command, args) => {
    calls.push([command, ...args])
    const child = new FakeChild()
    children.push(child)
    return child as unknown as ChildProcessWithoutNullStreams
  }
  return { spawn, children, calls }
}

describe('KeepAwake', () => {
  it('holds while any run works and lets go when the last one ends', async () => {
    const f = fakeSpawn()
    const awake = new KeepAwake({ spawn: f.spawn, command: ['helper', ['--hold']] })
    awake.set(1)
    awake.set(2)
    expect(f.calls).toEqual([['helper', '--hold']])
    expect(awake.holding).toBe(true)
    awake.set(0)
    expect(awake.holding).toBe(false)
    expect(f.children[0]).toMatchObject({ killed: true })
    await new Promise(r => setImmediate(r))
    expect(f.children[0]?.stdinEnded).toBe(true)
  })

  it('notices when the helper dies, and holds again next time', () => {
    const f = fakeSpawn()
    const awake = new KeepAwake({ spawn: f.spawn, command: ['helper', []] })
    awake.hold()
    f.children[0]!.emit('exit', 1, null)
    expect(awake.holding).toBe(false)
    awake.hold()
    expect(f.calls).toHaveLength(2)
  })

  it('does nothing where the platform has no way to hold', () => {
    const f = fakeSpawn()
    const awake = new KeepAwake({ spawn: f.spawn, command: null })
    awake.set(3)
    expect([awake.supported, awake.holding, f.calls.length]).toEqual([false, false, 0])
  })

  it('uses SetThreadExecutionState on Windows and caffeinate on macOS', () => {
    const [win, winArgs] = keepAwakeCommand('win32')!
    expect(win).toBe('powershell.exe')
    expect(winArgs.at(-1)).toContain('SetThreadExecutionState([uint32]2147483649)')
    expect(keepAwakeCommand('darwin', 42)).toEqual(['caffeinate', ['-i', '-w', '42']])
    expect(keepAwakeCommand('linux')).toBeNull()
  })
})

describe('isElevated', () => {
  const whoami =
    (level: string): Exec =>
    async () => ({ code: 0, stdout: `Everyone  Well-known group S-1-1-0\r\nMandatory Label\\${level}\r\n`, stderr: '' })

  it('reads the integrity level from whoami /groups on Windows', async () => {
    expect(await isElevated(whoami('High Mandatory Level Label S-1-16-12288'), 'win32')).toBe(true)
    expect(await isElevated(whoami('Medium Mandatory Level Label S-1-16-8192'), 'win32')).toBe(false)
  })
})
