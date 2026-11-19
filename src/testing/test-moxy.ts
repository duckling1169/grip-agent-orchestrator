import { onTestFinished } from 'vitest'

import { startMoxy } from '../app.js'
import type { Moxy, MoxyOptions } from '../app.js'
import { inboxPart } from '../moxy/prompt.js'
import { KeepAwake } from '../platform/keep-awake.js'
import { ModelCatalog } from '../providers/models.js'
import type { LeaderRunner, LeaderTurnRequest } from '../runtime/leaders/leader.js'
import { freePort } from '../ports.js'
import { FAKE_CLAW_CLI, silentLog, temporaryHome } from './harness.js'

export const ALLOWED_LOGIN = 'you@example.com'

export type EchoLeader = LeaderRunner & { requests: LeaderTurnRequest[] }

export function echoLeader(): EchoLeader {
  return {
    requests: [],
    async run(request) {
      this.requests.push(request)
      return { output: `You said: ${inboxPart(request.message)}`, error: null, nativeSessionId: 'native-1' }
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
    tailscaleOwner: async () => ALLOWED_LOGIN,
    log: silentLog,
    quotaReaders: {
      codex: async () => ({ engine: 'codex', windows: [] }),
      agy: async () => ({ engine: 'agy', windows: [] }),
      claude: async () => ({ engine: 'claude', windows: [] }),
    },
    models: new ModelCatalog({ installed: () => true, probe: async () => [] }),
    leaderAvailable: () => true,
    keepAwake: new KeepAwake({ command: null }),
    pushSender: async () => ({ ok: true }),
    machines: {
      get: async () => ({ machines: [], checkedAt: new Date().toISOString(), error: null }),
      refresh: async () => ({ machines: [], checkedAt: new Date().toISOString(), error: null }),
    },
    ...options,
  })
  onTestFinished(() => moxy.stop())
  return moxy
}
