import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type ExecResult = { code: number; stdout: string; stderr: string }
export type Exec = (command: string, args: readonly string[], options?: { timeoutMs?: number }) => Promise<ExecResult>

/**
 * On Windows `npm` is a `.cmd` shim, which Node only spawns through a shell. npm's own entry
 * script next to this Node runs it with no shell at all.
 */
function resolveCommand(command: string, args: readonly string[]): [string, string[]] {
  if (process.platform === 'win32' && command.toLowerCase() === 'npm') {
    const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(cli)) return [process.execPath, [cli, ...args]]
    throw new Error(`npm not found next to ${process.execPath}`)
  }
  return [command, [...args]]
}

/** Run a command to completion, never through a shell. */
export const exec: Exec = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    let file: string
    let argv: string[]
    try {
      ;[file, argv] = resolveCommand(command, args)
    } catch (error) {
      reject(error)
      return
    }
    const child = spawn(file, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
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

/** Like `exec`, but a non-zero exit is an error carrying stderr's last line. */
export async function execOk(run: Exec, command: string, args: readonly string[], timeoutMs?: number): Promise<string> {
  const result = await run(command, args, timeoutMs === undefined ? {} : { timeoutMs })
  if (result.code !== 0) {
    const reason = result.stderr.trim().split(/\r?\n/).pop() || `exit ${result.code}`
    throw new Error(`${command} ${args[0] ?? ''}: ${reason}`)
  }
  return result.stdout
}
