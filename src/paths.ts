import { homedir } from 'node:os'
import { join } from 'node:path'

/** Grip's own state folder on the principal: `~/.grip`, or `GRIP_HOME` when set. */
export function gripHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.GRIP_HOME || join(homedir(), '.grip')
}

export const gripPaths = (home = gripHome()) => ({
  home,
  config: join(home, 'config.json'),
  clawState: join(home, 'claw.json'),
  clawToken: join(home, 'claw-token'),
  quota: join(home, 'quota.json'),
  push: join(home, 'push.json'),
  logs: join(home, 'logs'),
  clawLog: join(home, 'logs', 'claw.log'),
})
