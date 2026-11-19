import { onTestFinished } from 'vitest'

import { startMoxy } from '../app.js'
import type { Moxy, MoxyOptions } from '../app.js'
import type { LeaderRunner, LeaderTurnRequest } from '../runtime/leaders/leader.js'
import { FAKE_CLAW_CLI, freePort, silentLog, temporaryHome } from './harness.js'

export const ALLOWED_LOGIN = 'you@example.com'

export type EchoLeader = LeaderRunner & { requests: LeaderTurnRequest[] }

export function echoLeader(): EchoLeader {
  return {
    requests: [],
    async run(request) {
      this.requests.push(request)
      return { output: `You said: ${request.message}`, error: null, nativeSessionId: 'native-1' }
    },
    async stop() {},
  }
}

export async function startTestMoxy(options: MoxyOptions = {}): Promise<Moxy> {
  const leader = echoLeader()
  const moxy = await startMoxy({
    home: await temporaryHome(),
    clawPort: await freePort(),
    mcpPort: await freePort(),
    webPort: await freePort(),
    clawCli: FAKE_CLAW_CLI,
    leaders: () => leader,
    workspace: '/work',
    tailscaleOwner: async () => ALLOWED_LOGIN,
    log: silentLog,
    quotaReaders: {
      codex: async () => ({ engine: 'codex', windows: [] }),
      agy: async () => ({ engine: 'agy', windows: [] }),
      claude: async () => ({ engine: 'claude', windows: [] }),
    },
    models: { get: async engine => ({ engine, models: [], error: null }) },
    pushSender: async () => ({ ok: true }),
    ...options,
  })
  onTestFinished(() => moxy.stop())
  return moxy
}
