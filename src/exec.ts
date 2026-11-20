import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type ExecResult = { code: number; stdout: string; stderr: string }
export type Exec = (command: string, args: readonly string[], options?: { timeoutMs?: number; cwd?: string }) => Promise<ExecResult>

function resolveCommand(command: string, args: readonly string[]): [string, string[]] {
  if (process.platform === 'win32' && command.toLowerCase() === 'npm') {
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(npmCli)) return [process.execPath, [npmCli, ...args]]
    throw new Error(`npm not found next to ${process.execPath}`)
  }
  return [command, [...args]]
}

export const exec: Exec = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const [file, argv] = resolveCommand(command, args)
    const child = spawn(file, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(options.cwd ? { cwd: options.cwd } : {}) })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', chunk => (stderr += chunk))
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill()
          reject(new Error(`${command} ${args.join(' ')}: timed out after ${options.timeoutMs} ms`))
        }, options.timeoutMs)
      : null
    child.on('error', error => {
      if (timer) clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })

export type SpawnPiped = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string; env?: Record<string, string> },
) => ChildProcessWithoutNullStreams

export const spawnPiped: SpawnPiped = (command, args, options = {}) => {
  const [file, argv] = resolveCommand(command, args)
  return spawn(file, argv, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
  })
}

export async function execOk(run: Exec, command: string, args: readonly string[], timeoutMs?: number): Promise<string> {
  const result = await run(command, args, timeoutMs === undefined ? {} : { timeoutMs })
  if (result.code !== 0) {
    const reason = result.stderr.trim().split(/\r?\n/).pop() || `exit ${result.code}`
    throw new Error(`${command} ${args[0] ?? ''}: ${reason}`)
  }
  return result.stdout
}
