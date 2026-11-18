import { randomBytes } from 'node:crypto'

import { sessionShapeProblems } from './client.js'
import type { ClawClient, ClawEngine } from './client.js'

export type GateCheck = { name: string; ok: boolean; detail?: string }
export type GateResult = { ok: boolean; checks: GateCheck[] }

export type GateOptions = {
  client: ClawClient
  expectedVersion: string
  /** Engines to start and stop once each. Only those installed and signed in on this machine. */
  engines: readonly ClawEngine[]
  /** An empty scratch folder the no-op sessions start in. */
  cwd: string
}

/**
 * Is this Claw one Grip can use? It answers, it is the version just installed, the fields Grip
 * reads are where they were, and each engine can open and close a session. No session is sent a
 * prompt, so the gate spends no quota.
 */
export async function healthGate(options: GateOptions): Promise<GateResult> {
  const { client } = options
  const checks: GateCheck[] = []
  const record = (name: string, ok: boolean, detail?: string) => {
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail })
    return ok
  }

  const health = await client.health(5000)
  if (!record('health', !!health, health ? undefined : 'no answer on /health')) return { ok: false, checks }
  record('version', health!.version === options.expectedVersion, `running ${health!.version}, expected ${options.expectedVersion}`)

  try {
    const sessions = await client.listSessions()
    const problems = sessions.flatMap(s => sessionShapeProblems(s).map(p => `${(s as { name?: string }).name ?? '?'}: ${p}`))
    record('session list shape', problems.length === 0, problems.join('; ') || undefined)
  } catch (error) {
    record('session list shape', false, (error as Error).message)
  }

  for (const engine of options.engines) {
    const name = `grip-gate-${engine}-${randomBytes(3).toString('hex')}`
    let started = false
    try {
      const session = await client.startSession({ name, cwd: options.cwd, engine })
      started = true
      const problems = sessionShapeProblems(session)
      const listed = (await client.listSessions()).some(s => s.name === name)
      record(
        `${engine} session start`,
        problems.length === 0 && listed,
        [...problems, ...(listed ? [] : ['not in the session list'])].join('; ') || undefined,
      )
    } catch (error) {
      record(`${engine} session start`, false, (error as Error).message)
    } finally {
      if (started) {
        try {
          await client.stopSession(name)
          const still = (await client.listSessions()).some(s => s.name === name)
          record(`${engine} session stop`, !still, still ? 'still listed after stop' : undefined)
        } catch (error) {
          record(`${engine} session stop`, false, (error as Error).message)
        }
      }
    }
  }

  return { ok: checks.every(c => c.ok), checks }
}

export function gateSummary(result: GateResult): string {
  const failed = result.checks.filter(c => !c.ok)
  return failed.length ? failed.map(c => `${c.name}${c.detail ? ` (${c.detail})` : ''}`).join(', ') : 'all checks passed'
}
