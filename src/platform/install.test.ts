import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Snapshot } from '../contracts/api.js'
import type { Exec } from '../exec.js'
import { CLAW_PACKAGE } from '../runtime/claw/install.js'
import { temporaryHome } from '../testing/harness.js'
import { install, restart, status, stop, uninstall, upgradeClaw, workingText } from './install.js'
import type { CommandContext, LocalMoxy } from './install.js'
import { LogonTask, taskXml } from './logon-task.js'
import { ensureServe, serveState } from './tailscale.js'

const PORT = 18798
const serveJson = (proxy: string) => JSON.stringify({ Web: { 'pc.tail.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } } })
const idle = { workers: [], conversation: [] } as unknown as Snapshot
const busy = {
  workers: [{ status: 'running' }, { status: 'finished' }],
  conversation: [{ type: 'moxy', turn: { status: 'running' } }],
} as unknown as Snapshot

type MachineOptions = {
  claw?: string | null
  serve?: string
  elevated?: boolean
  running?: boolean
  state?: Snapshot
  task?: boolean
  built?: boolean
}

async function machine(options: MachineOptions = {}) {
  const home = await temporaryHome()
  const staticDir = join(home, 'web')
  if (options.built !== false) {
    await mkdir(staticDir)
    await writeFile(join(staticDir, 'index.html'), '<!doctype html>')
  }
  const globalRoot = join(home, 'npm-global')
  const clawFolder = join(globalRoot, ...CLAW_PACKAGE.split('/'))
  const writeClaw = async (version: string) => {
    await mkdir(clawFolder, { recursive: true })
    await writeFile(join(clawFolder, 'package.json'), JSON.stringify({ version }))
  }
  if (options.claw) await writeClaw(options.claw)
  let serve = options.serve ?? '{}'
  let taskRegistered = options.task ?? false
  let up = options.running ?? false
  const calls: string[] = []
  const run: Exec = async (command, args) => {
    const line = [command.split(/[\\/]/).pop(), ...args].join(' ')
    if (command.endsWith('whoami.exe')) return { code: 0, stdout: options.elevated ? 'S-1-16-12288' : 'S-1-16-8192', stderr: '' }
    calls.push(line)
    if (line === 'npm root -g') return { code: 0, stdout: `${globalRoot}\n`, stderr: '' }
    if (line.startsWith('npm install -g')) await writeClaw('7.30.0')
    if (line === 'tailscale status --json') {
      const stdout = JSON.stringify({ BackendState: 'Running', Self: { UserID: 1 }, User: { 1: { LoginName: 'you@example.com' } } })
      return { code: 0, stdout, stderr: '' }
    }
    if (line === 'tailscale serve status --json') return { code: 0, stdout: serve, stderr: '' }
    if (line === `tailscale serve --bg ${PORT}`) serve = serveJson(`http://127.0.0.1:${PORT}`)
    if (line.startsWith('schtasks /Create')) taskRegistered = true
    if (line.startsWith('schtasks /Delete')) taskRegistered = false
    if (line.startsWith('schtasks /Query')) return { code: taskRegistered ? 0 : 1, stdout: '<Task/>', stderr: 'ERROR: not found' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const moxy: LocalMoxy = {
    running: async () => up,
    waitUntilRunning: async () => {
      calls.push('wait running')
      return (up = true)
    },
    state: async () => options.state ?? idle,
    shutdown: async () => {
      calls.push('shutdown')
      up = false
      return { pid: 4242 }
    },
  }
  const lines: string[] = []
  const context: CommandContext = {
    home: join(home, '.moxy'),
    customHome: true,
    cli: 'C:\\moxy\\dist\\cli.js',
    staticDir,
    out: line => lines.push(line),
    run,
    platform: 'win32',
    moxy,
    waitForExit: async pid => (calls.push(`wait exit ${pid}`), true),
  }
  return { context, calls, lines, serve: () => serve }
}

describe('moxy install', () => {
  it('installs Claw, allows the Tailscale owner, publishes Moxy, and starts it at logon', async () => {
    const m = await machine()
    await install(m.context)
    expect(m.calls).toContain(`npm install -g ${CLAW_PACKAGE}@>=7.23.4 <8 --no-fund --no-audit`)
    expect(m.calls).toContain(`tailscale serve --bg ${PORT}`)
    expect(m.calls.filter(call => call.startsWith('schtasks')).map(call => call.split(' ').slice(0, 3).join(' '))).toEqual([
      'schtasks /Create /TN',
      'schtasks /Run /TN',
    ])
    expect(m.calls.at(-1)).toBe('wait running')
    expect(JSON.parse(await readFile(join(m.context.home, 'config.json'), 'utf8'))).toMatchObject({ allowedLogins: ['you@example.com'] })
    expect(m.lines).toEqual([
      'installing Claw…',
      'installed Claw 7.30.0',
      'devices signed in as you@example.com can use Moxy',
      'published Moxy on your tailnet with tailscale serve',
      expect.stringContaining('registered the "Moxy" logon task'),
      'starting Moxy…',
      'Moxy is running',
    ])
  })

  it('warns and continues when the web app has not been built', async () => {
    const m = await machine({ built: false })
    await install(m.context)
    expect(m.lines[0]).toBe(`! the web app is not built (${m.context.staticDir}); run npm run build`)
    expect(m.lines.at(-1)).toBe('Moxy is running')
  })

  it('keeps a supported Claw and never replaces another tailscale serve mapping', async () => {
    const other = serveJson('http://127.0.0.1:3000')
    const m = await machine({ claw: '7.24.0', serve: other, running: true })
    await install(m.context)
    expect(m.calls.some(call => call.startsWith('npm install'))).toBe(false)
    expect(m.calls).not.toContain(`tailscale serve --bg ${PORT}`)
    expect(m.serve()).toBe(other)
    expect(m.calls.some(call => call.startsWith('schtasks /Run'))).toBe(false)
    expect(m.lines).toContain('Claw 7.24.0 is installed')
    expect(m.lines).toContainEqual(expect.stringContaining("sends this machine's HTTPS root to http://127.0.0.1:3000"))
    expect(m.lines.at(-1)).toContain('moxy restart')
  })

  it('refuses to install elevated or outside Windows', async () => {
    const elevated = await machine({ elevated: true })
    await expect(install(elevated.context)).rejects.toThrow('running elevated')
    expect(elevated.calls).toEqual([])
    const mac = await machine()
    await expect(install({ ...mac.context, platform: 'darwin' })).rejects.toThrow('Windows only')
  })

  it('removes only the logon task on uninstall', async () => {
    const m = await machine({ task: true })
    await uninstall(m.context)
    expect(m.calls.filter(call => call.startsWith('schtasks')).map(call => call.split(' ')[1])).toEqual(['/Query', '/End', '/Delete'])
    expect(m.lines).toContainEqual(expect.stringContaining('kept'))
  })
})

describe('moxy stop, restart and upgrade-claw', () => {
  it('refuses to stop while work runs, unless forced', async () => {
    const m = await machine({ running: true, state: busy })
    await expect(stop(m.context)).rejects.toThrow('Moxy is replying and 1 worker is working')
    expect(m.calls).not.toContain('shutdown')
    expect(await stop(m.context, true)).toBe(true)
    expect(m.calls).toEqual(['shutdown', 'wait exit 4242'])
  })

  it('restarts through the logon task after Moxy exits', async () => {
    const m = await machine({ running: true, task: true })
    await restart(m.context)
    expect(m.calls.map(call => call.split(' ').slice(0, 2).join(' '))).toEqual([
      'schtasks /Query',
      'shutdown',
      'wait exit',
      'schtasks /End',
      'schtasks /Run',
      'wait running',
    ])
  })

  it('upgrades Claw only while Moxy is stopped, then starts it again', async () => {
    const m = await machine({ claw: '7.24.0', running: true, task: true })
    await upgradeClaw(m.context)
    const order = ['shutdown', 'npm install', 'schtasks /Run', 'wait running'].map(step => m.calls.findIndex(call => call.startsWith(step)))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order.every(index => index >= 0)).toBe(true)
    expect(m.lines).toContain('upgraded Claw 7.24.0 to 7.30.0')
  })

  it('reports what runs', async () => {
    const m = await machine({ claw: '6.0.0', running: true, task: true, serve: serveJson(`http://127.0.0.1:${PORT}`), state: busy })
    await status(m.context)
    expect(m.lines).toEqual([
      `Moxy       running on port ${PORT}`,
      'Logon task registered',
      'Tailscale  signed in as you@example.com; tailscale serve publishes Moxy',
      'Claw       6.0.0 (Moxy needs >=7.23.4 <8)',
      'Working    Moxy is replying and 1 worker is working',
    ])
    expect(workingText(idle)).toBe('')
  })
})

describe('logon task', () => {
  const command = {
    node: 'C:\\Program Files\\nodejs\\node.exe',
    cli: 'C:\\moxy\\dist\\cli.js',
    args: ['serve'],
    cwd: 'C:\\Users\\you\\.moxy',
  }

  it('runs Moxy at logon, only while you are logged on, with normal rights and no window', () => {
    const xml = taskXml(command, 'PC\\you & me', 'C:\\Windows\\System32\\conhost.exe')
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>')
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>')
    expect(xml).toContain('<UserId>PC\\you &amp; me</UserId>')
    expect(xml).toContain('<Arguments>--headless &quot;C:\\Program Files\\nodejs\\node.exe&quot; C:\\moxy\\dist\\cli.js serve</Arguments>')
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
  })

  it('registers through schtasks with UTF-16 XML and removes the file', async () => {
    let file = ''
    const run: Exec = async (_command, args) => {
      file = args[args.indexOf('/XML') + 1]!
      const bytes = await readFile(file)
      expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe])
      expect(bytes.subarray(2).toString('utf16le')).toContain('<LogonTrigger>')
      return { code: 0, stdout: 'SUCCESS', stderr: '' }
    }
    await new LogonTask(run).register(taskXml(command, 'PC\\you'))
    await expect(readFile(file)).rejects.toThrow()
  })

  it('says why schtasks refused', async () => {
    const run: Exec = async () => ({ code: 1, stdout: '', stderr: 'ERROR: Access is denied.' })
    await expect(new LogonTask(run).start()).rejects.toThrow('schtasks /Run: ERROR: Access is denied.')
  })
})

describe('tailscale serve', () => {
  it('reads what serves the HTTPS root', () => {
    expect(serveState(serveJson('http://127.0.0.1:18798'), PORT)).toEqual({ kind: 'moxy' })
    expect(serveState(serveJson('http://localhost:18798/'), PORT)).toEqual({ kind: 'moxy' })
    expect(serveState(serveJson('http://127.0.0.1:3000'), PORT)).toEqual({ kind: 'other', target: 'http://127.0.0.1:3000' })
    expect(serveState('{}', PORT)).toEqual({ kind: 'none' })
    expect(serveState('not json', PORT)).toMatchObject({ kind: 'unavailable' })
  })

  it('reports a failed publish instead of throwing', async () => {
    const run: Exec = async (_command, args) =>
      args[1] === 'status' ? { code: 0, stdout: '{}', stderr: '' } : { code: 1, stdout: '', stderr: 'serve: access denied' }
    expect(await ensureServe(PORT, run)).toEqual({ state: { kind: 'unavailable', reason: 'serve: access denied' }, changed: false })
  })
})
