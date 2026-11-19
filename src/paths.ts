import { homedir } from 'node:os'
import { join } from 'node:path'

export function moxyHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MOXY_HOME || join(homedir(), '.moxy')
}

export type MoxyPaths = ReturnType<typeof moxyPaths>

export const moxyPaths = (home = moxyHome()) => ({
  home,
  database: join(home, 'moxy.db'),
  config: join(home, 'config.json'),
  quota: join(home, 'quota.json'),
  clawToken: join(home, 'claw-token'),
  mcpToken: join(home, 'mcp-token'),
  webToken: join(home, 'web-token'),
  leaderMcpConfig: join(home, 'leader-mcp.json'),
  moxyLog: join(home, 'logs', 'moxy.log'),
  clawLog: join(home, 'logs', 'claw.log'),
})
