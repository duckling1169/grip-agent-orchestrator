import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

import { spawnPiped as defaultSpawn } from '../exec.js'
import type { SpawnPiped } from '../exec.js'

/** The machine is about to go offline: it is going to sleep, shutting down, or you are signing out. */
export type GoingOffline = 'sleep' | 'shutdown' | 'logoff'

/**
 * .NET's `SystemEvents` from a PowerShell helper, since Node cannot see Windows power events.
 * It prints `ready`, then one line when Windows is about to sleep, shut down or sign you out, and
 * holds Windows back (at most a few seconds) until Grip answers on stdin, so the notification
 * goes out while the network is still up. `SystemEvents` needs a message loop, which it makes
 * itself on a thread of its own when it is first used from an MTA thread.
 */
const WINDOWS_SCRIPT = `Add-Type -TypeDefinition @'
using System;
using System.Threading;
using Microsoft.Win32;
public static class GripPowerEvents {
  static readonly AutoResetEvent answered = new AutoResetEvent(false);
  static readonly object gate = new object();
  static void Say(string line) { lock (gate) { Console.Out.WriteLine(line); Console.Out.Flush(); } }
  static void Offline(string why) { answered.Reset(); Say(why); answered.WaitOne(4000); }
  public static void Run() {
    var thread = new Thread(() => {
      SystemEvents.PowerModeChanged += (s, e) => { if (e.Mode == PowerModes.Suspend) Offline("sleep"); };
      SystemEvents.SessionEnding += (s, e) => Offline(e.Reason == SessionEndReasons.SystemShutdown ? "shutdown" : "logoff");
    });
    thread.SetApartmentState(ApartmentState.MTA);
    thread.Start();
    thread.Join();
    Say("ready");
    while (Console.In.ReadLine() != null) answered.Set();
  }
}
'@
[GripPowerEvents]::Run()`

export function powerEventsCommand(platform: NodeJS.Platform = process.platform): [string, string[]] | null {
  if (platform === 'win32') return ['powershell.exe', ['-MTA', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT]]
  return null
}

const OFFLINE = new Set<string>(['sleep', 'shutdown', 'logoff'])

export type PowerEventsOptions = {
  /** Runs before Windows carries on; it gets a few seconds, so it should only send a notification. */
  onOffline: (why: GoingOffline) => Promise<void>
  spawn?: SpawnPiped
  command?: [string, string[]] | null
  log?: (line: string) => void
  /** How long Grip waits for onOffline before letting Windows go on. Below the helper's own limit. */
  answerWithinMs?: number
}

/**
 * Tells Grip when the principal is about to go offline (design §13), so devices hear about it
 * from a notification instead of finding Grip unreachable. A restart of Grip itself is not one.
 */
export class PowerEvents {
  private child: ChildProcessWithoutNullStreams | null = null

  constructor(private readonly options: PowerEventsOptions) {}

  start(): void {
    const command = this.options.command === undefined ? powerEventsCommand() : this.options.command
    if (!command || this.child) return
    const log = this.options.log ?? (() => undefined)
    let child: ChildProcessWithoutNullStreams
    try {
      child = (this.options.spawn ?? defaultSpawn)(command[0], command[1])
    } catch (error) {
      log(`power events could not start: ${(error as Error).message}`)
      return
    }
    this.child = child
    child.stdin.on('error', () => undefined)
    child.on('error', error => log(`power events: ${error.message}`))
    child.on('exit', code => {
      if (this.child !== child) return
      this.child = null
      log(`power events helper exited (${code ?? 'signal'}); devices won't hear when this machine goes offline`)
    })
    createInterface({ input: child.stdout }).on('line', line => {
      const why = line.trim()
      if (!OFFLINE.has(why)) return
      void this.answer(child, why as GoingOffline)
    })
  }

  private async answer(child: ChildProcessWithoutNullStreams, why: GoingOffline): Promise<void> {
    const limit = new Promise<void>(resolve => setTimeout(resolve, this.options.answerWithinMs ?? 3500).unref())
    await Promise.race([this.options.onOffline(why).catch(() => undefined), limit])
    if (!child.stdin.destroyed) child.stdin.write('done\n')
  }

  stop(): void {
    const child = this.child
    this.child = null
    if (!child) return
    child.stdin.end()
    child.kill()
  }
}
