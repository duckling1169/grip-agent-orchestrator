import { randomBytes } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import { lastLine } from '../errors.js'
import { exec as defaultExec } from '../exec.js'
import type { Exec } from '../exec.js'

export const TASK_NAME = 'Moxy'

export type TaskCommand = { node: string; cli: string; args: readonly string[]; cwd: string }

export function currentUser(env: NodeJS.ProcessEnv = process.env): string {
  const name = userInfo().username
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${name}` : name
}

export const conhost = (env: NodeJS.ProcessEnv = process.env) => join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe')

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

const quoteArg = (arg: string) => (arg === '' || /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)

export function taskXml(command: TaskCommand, user: string, host = conhost()): string {
  const args = ['--headless', command.node, command.cli, ...command.args].map(quoteArg).join(' ')
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Moxy: one conversation that coordinates coding agents, from your tailnet devices. Made by moxy install.</Description>
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

export class LogonTask {
  constructor(private readonly run: Exec = defaultExec) {}

  async definition(): Promise<string | null> {
    const result = await this.schtasks(['/Query', '/TN', TASK_NAME, '/XML'])
    return result.ok ? result.out : null
  }

  async register(xml: string): Promise<void> {
    const file = join(tmpdir(), `moxy-task-${randomBytes(4).toString('hex')}.xml`)
    await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]))
    try {
      await this.must(['/Create', '/TN', TASK_NAME, '/XML', file, '/F'])
    } finally {
      await unlink(file).catch(() => undefined)
    }
  }

  start(): Promise<void> {
    return this.must(['/Run', '/TN', TASK_NAME])
  }

  async end(): Promise<void> {
    await this.schtasks(['/End', '/TN', TASK_NAME])
  }

  remove(): Promise<void> {
    return this.must(['/Delete', '/TN', TASK_NAME, '/F'])
  }

  private async schtasks(args: string[]): Promise<{ ok: boolean; out: string }> {
    const result = await this.run('schtasks', args, { timeoutMs: 30_000 })
    return { ok: result.code === 0, out: (result.code === 0 ? result.stdout : result.stderr || result.stdout).trim() }
  }

  private async must(args: string[]): Promise<void> {
    const result = await this.schtasks(args)
    if (!result.ok) throw new Error(`schtasks ${args[0]}: ${lastLine(result.out) || 'failed'}`)
  }
}
