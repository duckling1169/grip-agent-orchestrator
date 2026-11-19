import { engineSpec } from '../../contracts/engines.js'
import type { Engine } from '../../contracts/engines.js'
import { ACP_COMMANDS, isAcpEngine } from '../acp-process.js'
import { AcpLeader } from './acp-leader.js'
import type { AcpLeaderOptions } from './acp-leader.js'
import type { LeaderRunner } from './leader.js'

export type LeaderRunners = (engine: Engine) => LeaderRunner

export function leaderRunners(claude: LeaderRunner, acpOptions: AcpLeaderOptions = {}): LeaderRunners {
  const acp = new Map<Engine, LeaderRunner>()
  return engine => {
    if (engine === 'claude') return claude
    if (!isAcpEngine(engine)) throw new Error(`${engineSpec(engine).name} cannot lead Moxy`)
    let runner = acp.get(engine)
    if (!runner) {
      runner = new AcpLeader(ACP_COMMANDS[engine](), acpOptions)
      acp.set(engine, runner)
    }
    return runner
  }
}
