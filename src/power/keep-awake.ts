import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { spawnPiped as defaultSpawn } from '../exec.js'
import type { SpawnPiped } from '../exec.js'

/**
 * `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` from a helper process. Node has
 * no way to call Win32 itself, so PowerShell calls it and then blocks reading stdin. The request
 * belongs to that thread: it ends when the helper exits, which happens when Grip closes its stdin
 * or Grip itself dies. The display may still sleep.
 */
const WINDOWS_SCRIPT = [
  '$k = Add-Type -Name Power -Namespace Grip -PassThru -MemberDefinition',
  '\'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);\';',
  'if ($k::SetThreadExecutionState([uint32]2147483649) -eq 0) { exit 2 };',
  "[Console]::Out.WriteLine('held'); [Console]::Out.Flush();",
  '[void][Console]::In.ReadToEnd()',
].join(' ')

/** How to hold the machine awake on this platform, or null where Grip does not yet. */
export function keepAwakeCommand(platform: NodeJS.Platform = process.platform, pid = process.pid): [string, string[]] | null {
  if (platform === 'win32') return ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT]]
  // The same assertion as `caffeinate -i`; `-w` ends it if Grip dies.
  if (platform === 'darwin') return ['caffeinate', ['-i', '-w', String(pid)]]
  return null
}

export type KeepAwakeOptions = { spawn?: SpawnPiped; command?: [string, string[]] | null; log?: (line: string) => void }

/**
 * Keeps the principal from sleeping while any run is active (design §14), and lets normal sleep
 * settings apply again once the last one ends.
 */
export class KeepAwake {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly spawn: SpawnPiped
  private readonly command: [string, string[]] | null
  private readonly log: (line: string) => void

  constructor(options: KeepAwakeOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawn
    this.command = options.command === undefined ? keepAwakeCommand() : options.command
    this.log = options.log ?? (() => undefined)
  }

  get supported(): boolean {
    return this.command !== null
  }

  get holding(): boolean {
    return this.child !== null
  }

  /** Follow the number of running runs: hold while it is above zero. */
  set(activeRuns: number): void {
    if (activeRuns > 0) this.hold()
    else this.release()
  }

  hold(): void {
    if (this.child || !this.command) return
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.spawn(this.command[0], this.command[1])
    } catch (error) {
      this.log(`keep-awake could not start: ${(error as Error).message}`)
      return
    }
    this.child = child
    child.stdin.on('error', () => undefined)
    child.on('error', error => this.log(`keep-awake: ${error.message}`))
    child.on('exit', code => {
      if (this.child !== child) return
      this.child = null
      this.log(`keep-awake helper exited (${code ?? 'signal'}); sleep is no longer held`)
    })
    this.log('keeping the machine awake while runs work')
  }

  release(): void {
    const child = this.child
    if (!child) return
    this.child = null
    // The hold ends with the helper process, however it ends.
    child.stdin.end()
    child.kill()
    this.log('machine may sleep again')
  }
}
