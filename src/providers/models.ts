// Uses the Agent Client Protocol SDK: https://github.com/agentclientprotocol/typescript-sdk

import { client, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'

import type { EngineModels, ModelOption } from '../contracts/api.js'
import { ENGINES, engineSpec } from '../contracts/engines.js'
import type { Engine } from '../contracts/engines.js'
import { errorText } from '../errors.js'
import { inTempFolder } from '../files.js'
import { ACP_COMMANDS, isAcpEngine, startAcpProcess } from '../runtime/acp-process.js'
import type { AcpCommand, AcpEngine, AcpProcessOptions } from '../runtime/acp-process.js'
import { engineUnavailable, isEngineInstalled } from '../runtime/engines.js'

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

const CLAUDE_MODELS: ModelOption[] = [
  { id: 'opus', efforts: CLAUDE_EFFORTS },
  { id: 'sonnet', efforts: CLAUDE_EFFORTS },
  { id: 'haiku', efforts: [] },
].map(({ id, efforts }) => ({ id, label: id[0]!.toUpperCase() + id.slice(1), efforts, isDefault: false }))

export type ModelCatalogOptions = {
  installed?: (engine: Engine) => boolean
  probe?: (engine: AcpEngine) => Promise<ModelOption[]>
  now?: () => number
  cacheMs?: number
}

export class ModelCatalog {
  private readonly cached = new Map<Engine, { at: number; value: Promise<EngineModels> }>()
  private readonly installed: (engine: Engine) => boolean
  private readonly probe: (engine: AcpEngine) => Promise<ModelOption[]>
  private readonly now: () => number
  private readonly cacheMs: number

  constructor(options: ModelCatalogOptions = {}) {
    this.installed = options.installed ?? isEngineInstalled
    this.probe = options.probe ?? (engine => probeAcpModels(ACP_COMMANDS[engine]()))
    this.now = options.now ?? Date.now
    this.cacheMs = options.cacheMs ?? 30 * 60_000
  }

  get(engine: Engine): Promise<EngineModels> {
    const cached = this.cached.get(engine)
    if (cached && this.now() - cached.at < this.cacheMs) return cached.value
    const value = this.read(engine)
    const entry = { at: this.now(), value }
    this.cached.set(engine, entry)
    void value.then(result => {
      if (result.error && this.cached.get(engine) === entry) this.cached.delete(engine)
    })
    return value
  }

  list(): Promise<EngineModels[]> {
    return Promise.all(ENGINES.filter(engine => this.installed(engine)).map(engine => this.get(engine)))
  }

  private async read(engine: Engine): Promise<EngineModels> {
    try {
      if (!this.installed(engine)) throw new Error(engineUnavailable(engine))
      const models = isAcpEngine(engine) ? await this.probe(engine) : engine === 'claude' ? CLAUDE_MODELS : []
      return { engine, models, error: null }
    } catch (error) {
      return { engine, models: [], error: errorText(error) }
    }
  }
}

export function checkModelChoice({ engine, models }: EngineModels, model?: string, effort?: string): void {
  if (!models.length) return
  const name = engineSpec(engine).name
  const option = models.find(candidate => candidate.id === model)
  if (!option) throw new Error(`choose a ${name} model: ${models.map(candidate => candidate.id).join(', ')}`)
  if (option.efforts.length && !(effort && option.efforts.includes(effort)))
    throw new Error(`choose an effort for ${name} ${option.id}: ${option.efforts.join(', ')}`)
  if (!option.efforts.length && effort) throw new Error(`${name} ${option.id} has no effort levels; leave effort out`)
}

export async function probeAcpModels(
  command: AcpCommand,
  options: AcpProcessOptions & { timeoutMs?: number } = {},
): Promise<ModelOption[]> {
  return inTempFolder(async cwd => {
    const process = startAcpProcess(command, cwd, options)
    const app = client({ name: 'moxy-models' }).onRequest('session/request_permission', () => ({ outcome: { outcome: 'cancelled' } }))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        app.connectWith(process.stream, async agent => {
          await agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
          const session = await agent.request('session/new', { cwd, mcpServers: [] })
          const config = selectOption(session.configOptions ?? [], 'model')
          if (!config) return []
          const models: ModelOption[] = []
          for (const model of choices(config)) {
            const options =
              model.value === config.currentValue
                ? (session.configOptions ?? [])
                : (
                    await agent.request('session/set_config_option', {
                      sessionId: session.sessionId,
                      configId: config.id,
                      value: model.value,
                    })
                  ).configOptions
            const effort = selectOption(options, 'thought_level')
            models.push({
              id: model.value,
              label: model.name,
              efforts: effort ? choices(effort).map(choice => choice.value) : [],
              isDefault: model.value === config.currentValue,
            })
          }
          return models
        }),
        process.failed('while listing models'),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('ACP model discovery timed out')), options.timeoutMs ?? 30_000)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      process.kill()
    }
  })
}

function selectOption(options: SessionConfigOption[], category: string): Extract<SessionConfigOption, { type: 'select' }> | undefined {
  return options.find(
    (option): option is Extract<SessionConfigOption, { type: 'select' }> => option.category === category && option.type === 'select',
  )
}

function choices(option: SessionConfigOption) {
  return option.type === 'select' ? option.options.flatMap(choice => ('options' in choice ? choice.options : [choice])) : []
}
