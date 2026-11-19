import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { errorText } from '../errors.js'
import { spawnPiped as defaultSpawn } from '../exec.js'
import type { SpawnPiped } from '../exec.js'
import type { Log } from '../log.js'

export type KeepAwakeCommand = { command: string; args: readonly string[] }

const WINDOWS_SCRIPT = [
  '$k = Add-Type -Name Power -Namespace Moxy -PassThru -MemberDefinition',
  '\'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);\';',
  'if ($k::SetThreadExecutionState([uint32]2147483649) -eq 0) { exit 2 };',
  "[Console]::Out.WriteLine('held'); [Console]::Out.Flush();",
  '[void][Console]::In.ReadToEnd()',
].join(' ')

export function keepAwakeCommand(platform: NodeJS.Platform = process.platform, pid = process.pid): KeepAwakeCommand | null {
  if (platform === 'win32')
    return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT] }
  if (platform === 'darwin') return { command: 'caffeinate', args: ['-i', '-w', String(pid)] }
  return null
}

export type KeepAwakeOptions = { command?: KeepAwakeCommand | null; spawn?: SpawnPiped; log?: Log }

export class KeepAwake {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly command: KeepAwakeCommand | null
  private readonly spawn: SpawnPiped
  private readonly log: Log

  constructor(options: KeepAwakeOptions = {}) {
    this.command = options.command === undefined ? keepAwakeCommand() : options.command
    this.spawn = options.spawn ?? defaultSpawn
    this.log = options.log ?? (() => undefined)
  }

  get holding(): boolean {
    return this.child !== null
  }

  set(active: boolean): void {
    if (active) this.hold()
    else this.release()
  }

  release(): void {
    const child = this.child
    if (!child) return
    this.child = null
    child.stdin.end()
    child.kill()
    this.log('the machine may sleep again')
  }

  private hold(): void {
    if (this.child || !this.command) return
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.spawn(this.command.command, this.command.args)
    } catch (error) {
      this.log(`keep-awake could not start: ${errorText(error)}`)
      return
    }
    this.child = child
    child.stdin.on('error', () => undefined)
    child.on('error', error => this.log(`keep-awake: ${errorText(error)}`))
    child.on('exit', code => {
      if (this.child !== child) return
      this.child = null
      this.log(`keep-awake helper exited (${code ?? 'signal'}); sleep is no longer held`)
    })
    this.log('keeping the machine awake while work runs')
  }
}
