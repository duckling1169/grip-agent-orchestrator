import type { Exec, ExecResult } from '../exec.js'

const GIT_TIMEOUT_MS = 120_000

export async function git(run: Exec, cwd: string, args: readonly string[]): Promise<ExecResult> {
  const result = await run('git', ['-C', cwd, ...args], { timeoutMs: GIT_TIMEOUT_MS })
  return { ...result, stdout: result.stdout.replace(/\r?\n$/, '') }
}

export async function gitOk(run: Exec, cwd: string, args: readonly string[]): Promise<string> {
  const result = await git(run, cwd, args)
  if (result.code !== 0) throw new Error(`git ${args[0] ?? ''}: ${lastLine(result.stderr) || `exit ${result.code}`}`)
  return result.stdout
}

export const lastLine = (text: string) => text.trim().split(/\r?\n/).pop() ?? ''
