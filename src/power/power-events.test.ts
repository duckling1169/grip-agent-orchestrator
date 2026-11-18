import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import type { SpawnPiped } from '../exec.js'
import { PowerEvents, powerEventsCommand } from './power-events.js'
import type { GoingOffline } from './power-events.js'

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  answers = ''
  constructor() {
    super()
    this.stdin.setEncoding('utf8').on('data', chunk => (this.answers += chunk))
  }
  kill() {
    this.killed = true
    return true
  }
}

function setup(onOffline: (why: GoingOffline) => Promise<void>, answerWithinMs?: number) {
  const children: FakeChild[] = []
  const spawn: SpawnPiped = () => {
    const child = new FakeChild()
    children.push(child)
    return child as unknown as ChildProcessWithoutNullStreams
  }
  const events = new PowerEvents({ onOffline, spawn, command: ['helper', []], ...(answerWithinMs ? { answerWithinMs } : {}) })
  events.start()
  return { events, child: children[0]! }
}

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

describe('PowerEvents', () => {
  it('runs on Windows only', () => {
    expect(powerEventsCommand('win32')?.[1]).toContain('-MTA')
    expect(powerEventsCommand('linux')).toBeNull()
  })

  it('tells Grip the machine is going offline, then lets Windows go on', async () => {
    const seen: GoingOffline[] = []
    const { child } = setup(async why => void seen.push(why))
    child.stdout.write('ready\nsomething else\nsleep\n')
    await tick(10)
    expect(seen).toEqual(['sleep'])
    expect(child.answers).toBe('done\n')
    child.stdout.write('shutdown\n')
    await tick(10)
    expect(seen).toEqual(['sleep', 'shutdown'])
  })

  it('does not hold Windows back for a notification that hangs', async () => {
    const { child } = setup(() => new Promise(() => undefined), 20)
    child.stdout.write('logoff\n')
    await tick(60)
    expect(child.answers).toBe('done\n')
  })

  it('stops the helper with Grip', () => {
    const { events, child } = setup(async () => undefined)
    events.stop()
    expect(child.killed).toBe(true)
  })
})
