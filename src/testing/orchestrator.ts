import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { ChatManager } from '../chats/manager.js'
import { ChatStore } from '../chats/store.js'
import type { Engine } from '../engines.js'
import { Worktrees } from '../git/worktrees.js'
import { startMcpHttp } from '../mcp/http.js'
import type { EngineModels } from '../models.js'
import { Quota } from '../quota/quota.js'
import type { QuotaReaders } from '../quota/readers.js'
import { RunManager } from '../runs/manager.js'
import { RunStore } from '../runs/store.js'
import { FakeClaw } from './fake-claw.js'

const TOKEN = 'scenario-token'

export type ScenarioOptions = {
  /** Percent of each provider's 5-hour window already used. */
  quotaUsed?: Partial<Record<'claude' | 'codex' | 'agy', number>>
  /** Engines whose CLI is installed; all of them when left out. */
  installed?: Engine[]
  models?: EngineModels[]
}

/** A worker's run as a scenario plays it: edit files in its worktree, then end its turn. */
export type ScriptedWorker = {
  edit(file: string, text: string): Promise<void>
  commit(message: string): void
  finish(output: string): Promise<void>
  fail(error: string): Promise<void>
}

/**
 * Grip's orchestrator MCP over HTTP, as an orchestrator model sees it, in front of a fake Claw
 * and a real git repo. A scenario plays the orchestrator by calling tools in the order a model
 * would; the workers are played by the test. Nothing calls a model (DESIGN §16).
 */
export async function scriptedOrchestrator(options: ScenarioOptions = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'grip-scenario-')))
  const cleanups: (() => Promise<unknown>)[] = [() => rm(base, { recursive: true, force: true })]
  const repo = join(base, 'app')
  await mkdir(join(repo, 'src'), { recursive: true })
  git(base, 'init', '-q', '-b', 'main', repo)
  await writeFile(join(repo, 'src', 'login.ts'), 'export const login = () => false\n')
  await writeFile(join(repo, 'README.md'), '# App\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'init')

  const claw = new FakeClaw()
  const home = join(base, 'home')
  const runStore = await RunStore.open(home)
  const installed = options.installed
  const manager = new RunManager({
    store: runStore,
    worktrees: new Worktrees(),
    claw,
    ...(installed ? { installed: (engine: Engine) => installed.includes(engine) } : {}),
  })
  cleanups.push(async () => {
    const { stopped } = await manager.stopAll()
    await Promise.all(stopped.map(run => manager.settled(run.id)))
  })
  let url: URL
  const chats = new ChatManager({ chats: await ChatStore.open(home), runStore, runs: manager, claw, secret: TOKEN, mcpUrl: () => url.href })

  const used = { claude: 10, codex: 10, agy: 10, ...options.quotaUsed }
  const window = (usedPercent: number) => ({
    name: '5h',
    usedPercent,
    resetsAt: '2099-01-01T00:00:00.000Z',
    stale: false,
    observedAt: null,
  })
  const readers: QuotaReaders = {
    claude: async () => ({ provider: 'claude', windows: [window(used.claude)] }),
    codex: async () => ({ provider: 'codex', windows: [window(used.codex)] }),
    agy: async () => ({ provider: 'agy', windows: [window(used.agy)] }),
  }
  const quota = await Quota.open({ path: join(home, 'quota.json'), readers })
  const models = {
    list: async (): Promise<EngineModels[]> =>
      options.models ?? [
        {
          engine: 'claude',
          models: [
            { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['high', 'max'], defaultEffort: null, isDefault: false },
            { id: 'claude-haiku-5-5', label: 'Haiku 5.5', efforts: [], defaultEffort: null, isDefault: false },
          ],
          error: null,
        },
        {
          engine: 'codex',
          models: [{ id: 'gpt-6', label: 'GPT-6', efforts: ['low', 'high'], defaultEffort: 'low', isDefault: true }],
          error: null,
        },
        {
          engine: 'agy',
          models: [{ id: 'gemini-4-pro-high', label: 'Gemini 4 Pro (High)', efforts: [], defaultEffort: null, isDefault: true }],
          error: null,
        },
      ],
  }
  const http = await startMcpHttp({ manager, quota, models, token: TOKEN, port: 0, chats })
  cleanups.push(http.close)
  url = new URL(`http://127.0.0.1:${http.port}/mcp`)

  const client = new Client({ name: 'scripted-orchestrator', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }))
  cleanups.push(() => client.close())

  /** Call a tool the way a model would; a tool error throws with Grip's message. */
  async function call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    const text = result.content[0]?.text ?? ''
    if (result.isError) throw new Error(text)
    return JSON.parse(text) as T
  }

  function worker(runId: string): ScriptedWorker {
    const session = `grip-${runId}`
    const worktree = () => {
      const run = runStore.get(runId)
      return run?.repo?.worktree ?? run?.cwd ?? repo
    }
    return {
      async edit(file, text) {
        const path = join(worktree(), file)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, text)
      },
      commit(message) {
        git(worktree(), 'add', '.')
        git(worktree(), 'commit', '-qm', message)
      },
      async finish(output) {
        await claw.waitForSend(session)
        claw.answer(session, { output })
        await manager.settled(runId)
      },
      async fail(error) {
        await claw.waitForSend(session)
        claw.answer(session, { output: '', error })
        await manager.settled(runId)
      },
    }
  }

  return {
    repo,
    claw,
    call,
    worker,
    /** What each run's Claw session was last sent, by run id. */
    /** Git in the repo, as the orchestrator runs it from its own shell (merging, for one). */
    git: (...args: string[]) => git(repo, ...args),
    sentTo: (runId: string) => claw.sends.filter(send => send.name === `grip-${runId}`).map(send => send.message),
    close: async () => {
      for (const cleanup of cleanups.reverse()) await cleanup()
    },
  }
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=grip-test', '-c', 'user.email=grip@test', '-C', cwd, ...args], { encoding: 'utf8' }).trim()
}
