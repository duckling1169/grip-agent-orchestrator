import { homedir } from 'node:os'
import { join } from 'node:path'

export function moxyHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MOXY_HOME || join(homedir(), '.moxy')
}

export type MoxyPaths = ReturnType<typeof moxyPaths>

export const moxyPaths = (home = moxyHome()) => ({
  home,
  database: join(home, 'moxy.db'),
  clawToken: join(home, 'claw-token'),
  moxyLog: join(home, 'logs', 'moxy.log'),
  clawLog: join(home, 'logs', 'claw.log'),
})
