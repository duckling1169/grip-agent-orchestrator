import { randomBytes } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import { exec as defaultExec } from '../exec.js'
import type { Exec } from '../exec.js'

export const TASK_NAME = 'Grip'

/** What the logon task runs: this Node, Grip's compiled CLI, and `serve`. */
export type TaskCommand = { node: string; cli: string; args: readonly string[]; cwd: string }

/** The account the task runs as and starts at logon for, as `DOMAIN\user`. */
export function currentUser(env: NodeJS.ProcessEnv = process.env): string {
  const name = userInfo().username
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${name}` : name
}

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/** One Windows command-line argument. Paths never hold quotes, so quoting spaces is enough. */
const quoteArg = (arg: string) => (arg === '' || /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)

/** Windows' own console host with no window, so Grip runs in your session without a console showing. */
export const conhost = (env: NodeJS.ProcessEnv = process.env) => join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe')

/**
 * The Task Scheduler definition (design §15): start at your logon and run only while you are
 * logged on, with your normal rights, never as a service and never elevated, so agy and Codex
 * reach their logins. No time limit, keep running on battery, one copy at a time, and restart
 * if it fails.
 */
export function taskXml(command: TaskCommand, user: string, host = conhost()): string {
  const args = ['--headless', command.node, command.cli, ...command.args].map(quoteArg).join(' ')
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Grip: delegate to coding agents and see them from your tailnet devices. Made by grip install.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(host)}</Command>
      <Arguments>${escapeXml(args)}</Arguments>
      <WorkingDirectory>${escapeXml(command.cwd)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`
}

/** Register, start, stop and remove Grip's logon task through `schtasks`, Windows' own tool. */
export class LogonTask {
  constructor(private readonly run: Exec = defaultExec) {}

  private async schtasks(args: string[]): Promise<{ ok: boolean; out: string }> {
    const result = await this.run('schtasks', args, { timeoutMs: 30_000 })
    const out = (result.code === 0 ? result.stdout : result.stderr || result.stdout).trim()
    return { ok: result.code === 0, out }
  }

  private async must(args: string[]): Promise<void> {
    const result = await this.schtasks(args)
    if (!result.ok) throw new Error(`schtasks ${args[0]}: ${result.out.split(/\r?\n/).pop() || 'failed'}`)
  }

  /** The registered definition, or null when there is no Grip task. */
  async definition(): Promise<string | null> {
    const result = await this.schtasks(['/Query', '/TN', TASK_NAME, '/XML'])
    return result.ok ? result.out : null
  }

  /** Create the task, replacing an earlier one. schtasks reads task XML as UTF-16. */
  async register(xml: string): Promise<void> {
    const file = join(tmpdir(), `grip-task-${randomBytes(4).toString('hex')}.xml`)
    await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]))
    try {
      await this.must(['/Create', '/TN', TASK_NAME, '/XML', file, '/F'])
    } finally {
      await unlink(file).catch(() => undefined)
    }
  }

  start = () => this.must(['/Run', '/TN', TASK_NAME])

  /** Stop the running task. Not running is fine. */
  async end(): Promise<void> {
    await this.schtasks(['/End', '/TN', TASK_NAME])
  }

  remove = () => this.must(['/Delete', '/TN', TASK_NAME, '/F'])
}
