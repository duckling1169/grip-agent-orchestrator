import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import type { Exec } from '../exec.js'
import { statusLines } from './commands.js'
import { LogonTask, taskXml } from './logon-task.js'
import { ensureServe, serveState } from './tailscale-serve.js'

const command = {
  node: 'C:\\Program Files\\nodejs\\node.exe',
  cli: 'C:\\grip\\dist\\src\\cli.js',
  args: ['serve'],
  cwd: 'C:\\Users\\you\\.grip',
}

describe('logon task', () => {
  it('runs Grip at your logon, only while you are logged on, with normal rights and no window', () => {
    const xml = taskXml(command, 'PC\\you & me', 'C:\\Windows\\System32\\conhost.exe')
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>')
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>')
    expect(xml).toContain('<UserId>PC\\you &amp; me</UserId>')
    expect(xml).toContain('<Command>C:\\Windows\\System32\\conhost.exe</Command>')
    expect(xml).toContain(
      '<Arguments>--headless &quot;C:\\Program Files\\nodejs\\node.exe&quot; C:\\grip\\dist\\src\\cli.js serve</Arguments>',
    )
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>')
  })

  it('registers through schtasks with the XML as UTF-16, and cleans up the file', async () => {
    const calls: string[][] = []
    let written = ''
    const run: Exec = async (cmd, args) => {
      calls.push([cmd, ...args])
      const file = args[args.indexOf('/XML') + 1]!
      const bytes = await readFile(file)
      expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe])
      written = bytes.subarray(2).toString('utf16le')
      return { code: 0, stdout: 'SUCCESS', stderr: '' }
    }
    await new LogonTask(run).register(taskXml(command, 'PC\\you'))
    expect(calls[0]?.slice(0, 4)).toEqual(['schtasks', '/Create', '/TN', 'Grip'])
    expect(calls[0]).toContain('/F')
    expect(written).toContain('<LogonTrigger>')
    await expect(readFile(calls[0]![calls[0]!.indexOf('/XML') + 1]!)).rejects.toThrow()
  })

  it('says why schtasks refused', async () => {
    const run: Exec = async () => ({ code: 1, stdout: '', stderr: 'ERROR: Access is denied.' })
    await expect(new LogonTask(run).start()).rejects.toThrow('schtasks /Run: ERROR: Access is denied.')
  })
})

const status = (proxy: string) =>
  JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { 'pc.tail.ts.net:443': { Handlers: { '/': { Proxy: proxy } } } } })

describe('tailscale serve', () => {
  it('reads what serves the HTTPS root', () => {
    expect(serveState(status('http://127.0.0.1:18798'), 18798)).toEqual({ kind: 'grip' })
    expect(serveState(status('http://localhost:18798/'), 18798)).toEqual({ kind: 'grip' })
    expect(serveState(status('http://127.0.0.1:3000'), 18798)).toEqual({ kind: 'other', target: 'http://127.0.0.1:3000' })
    expect(serveState('{}', 18798)).toEqual({ kind: 'none' })
    expect(serveState('', 18798)).toEqual({ kind: 'none' })
  })

  it('publishes Grip only when nothing is there, and never replaces something else', async () => {
    const calls: string[][] = []
    let current = '{}'
    const run: Exec = async (cmd, args) => {
      calls.push(args.slice())
      if (args[1] === '--bg') current = status('http://127.0.0.1:18798')
      return { code: 0, stdout: args[1] === 'status' ? current : '', stderr: '' }
    }
    expect(await ensureServe(18798, run)).toEqual({ state: { kind: 'grip' }, changed: true })
    expect(calls).toContainEqual(['serve', '--bg', '18798'])

    calls.length = 0
    current = status('http://127.0.0.1:3000')
    expect(await ensureServe(18798, run)).toEqual({ state: { kind: 'other', target: 'http://127.0.0.1:3000' }, changed: false })
    expect(calls).toEqual([['serve', 'status', '--json']])
  })
})

describe('grip status', () => {
  it('lists what is working, each worker once', () => {
    const now = Date.parse('2026-11-18T12:00:00Z')
    const run = { title: 'Fix login', engine: 'codex', status: 'running', createdAt: '2026-11-18T11:15:00Z' }
    const lines = statusLines(
      {
        claw: { status: 'ready', version: '7.23.4' },
        keepAwake: { supported: true, holding: true },
        chats: [{ title: 'Auth work', engine: 'claude', status: 'working', createdAt: '2026-11-18T10:00:00Z', runs: [run] }],
        runs: [run, { title: 'Old', engine: 'agy', status: 'done', createdAt: '2026-11-18T09:00:00Z' }],
      },
      now,
    )
    expect(lines).toEqual([
      'Claw       ready (7.23.4)',
      'Awake      kept awake while runs work',
      'Working    1 worker, 1 chat',
      '  Auth work (Claude, 2h 0m)',
      '  Fix login (GPT, 45m)',
    ])
  })
})
