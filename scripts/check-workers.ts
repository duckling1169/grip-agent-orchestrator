import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { ENGINES, isEngine } from '../src/contracts/engines.js'
import type { Engine } from '../src/contracts/engines.js'
import type { ModelOption } from '../src/contracts/api.js'
import { Database } from '../src/db/database.js'
import { MOXY_SCHEMA } from '../src/db/schema.js'
import { errorText } from '../src/errors.js'
import { exec, execOk } from '../src/exec.js'
import { loadOrCreateToken } from '../src/files.js'
import { moxyPaths } from '../src/paths.js'
import { freePort } from '../src/ports.js'
import { ModelCatalog } from '../src/providers/models.js'
import { protectedFolders } from '../src/repos/folders.js'
import { Worktrees } from '../src/repos/worktrees.js'
import { ClawClient } from '../src/runtime/claw/client.js'
import { assertSupportedClaw, installedClawCli } from '../src/runtime/claw/install.js'
import { ClawProcess } from '../src/runtime/claw/process.js'
import { isEngineInstalled } from '../src/runtime/engines.js'
import { Workers } from '../src/workers/service.js'
import { WorkerStore } from '../src/workers/store.js'

const TURN_TIMEOUT_MS = 10 * 60_000
const CHEAP_MODEL = /haiku|flash|mini|nano|lite|small|fast/i
const PROMPT = [
  'This is a permission check. Do exactly these steps in the current folder, then stop:',
  '1. Create a file named check.txt that contains the single line: ok',
  "2. Use the terminal to run: node -e \"require('fs').writeFileSync('terminal.txt','ok')\"",
  '3. Run: git add check.txt terminal.txt',
  '4. Run: git commit -m "Permission check"',
  '5. Run: node --version',
  'Reply with the output of node --version on its own line.',
].join('\n')

type Check = { engine: Engine; model: string | null; effort: string | null; ok: boolean; notes: string[] }

const asked = process.argv.slice(2)
const unknown = asked.filter(engine => !isEngine(engine))
if (unknown.length) throw new Error(`unknown engines: ${unknown.join(', ')}; choose from ${ENGINES.join(', ')}`)
const engines = (asked.length ? (asked as Engine[]) : ENGINES).filter(isEngineInstalled)
if (!engines.length) throw new Error('none of these engines is installed')

const scratch = await realpath(await mkdtemp(join(tmpdir(), 'moxy-check-workers-')))
const paths = moxyPaths(join(scratch, 'home'))
await mkdir(dirname(paths.clawLog), { recursive: true })
const repo = join(scratch, 'repo')
await mkdir(repo)
const git = (...args: string[]) => execOk(exec, 'git', ['-C', repo, ...args])
await git('init', '-q', '-b', 'main')
await git('config', 'user.name', 'Moxy Check')
await git('config', 'user.email', 'check@moxy.invalid')
await writeFile(join(repo, 'README.md'), '# permission check\n')
await git('add', '.')
await git('commit', '-q', '-m', 'start')

const clawPort = await freePort()
const client = new ClawClient(`http://127.0.0.1:${clawPort}`, await loadOrCreateToken(paths.clawToken))
const claw = new ClawProcess({ client, cliPath: await installedClawCli(), port: clawPort, logFile: paths.clawLog })
const database = Database.open(paths.database, MOXY_SCHEMA)
try {
  assertSupportedClaw((await claw.start()).version)
  const workers = new Workers({
    store: new WorkerStore(database),
    claw: client,
    worktrees: new Worktrees(),
    protectedFolders: protectedFolders(paths.home),
    isInstalled: isEngineInstalled,
    log: () => {},
    turnTimeoutMs: TURN_TIMEOUT_MS,
  })
  const models = new ModelCatalog()
  console.log(`Checking ${engines.join(', ')} in ${repo}. Each engine spends one small turn.`)
  const checks = await Promise.all(engines.map(engine => check(engine, workers, models)))
  for (const { engine, model, effort, ok, notes } of checks)
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${engine} ${[model, effort].filter(Boolean).join(' ')}${notes.length ? `\n      ${notes.join('\n      ')}` : ''}`,
    )
  process.exitCode = checks.every(result => result.ok) ? 0 : 1
} finally {
  await claw.stop()
  database.close()
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

async function check(engine: Engine, workers: Workers, models: ModelCatalog): Promise<Check> {
  const catalog = await models.get(engine)
  const option = cheapest(catalog.models)
  const effort = option?.efforts.includes('low') ? 'low' : (option?.efforts[0] ?? null)
  const result: Check = { engine, model: option?.id ?? null, effort, ok: false, notes: [] }
  try {
    const worker = await workers.delegate({
      folder: repo,
      engine,
      prompt: PROMPT,
      title: `check ${engine}`,
      ...(option ? { model: option.id } : {}),
      ...(effort ? { effort } : {}),
    })
    await workers.settled(worker.id)
    const { turns, facts } = await workers.result(worker.id)
    const turn = turns.at(-1)
    const output = turn?.output ?? ''
    if (turn?.status !== 'finished') result.notes.push(`turn ${turn?.status ?? 'missing'}: ${turn?.error ?? 'no error given'}`)
    const committed = facts?.lastCommit?.subject === 'Permission check' && facts.commitsAhead > 0
    if (!committed) result.notes.push(`no "Permission check" commit on the worker's branch (last: ${facts?.lastCommit?.subject ?? 'none'})`)
    const committedFiles = committed
      ? (await execOk(exec, 'git', ['-C', worker.cwd, 'ls-tree', '--name-only', 'HEAD', '--', 'check.txt', 'terminal.txt'])).split(/\r?\n/)
      : []
    const wroteFiles = committedFiles.includes('check.txt') && committedFiles.includes('terminal.txt')
    if (committed) {
      result.notes.push(wroteFiles ? 'commit contains check.txt and terminal.txt' : 'commit is missing check.txt or terminal.txt')
    }
    const ranNode = /v\d+\.\d+\.\d+/.test(output)
    if (!ranNode) result.notes.push('the reply has no node version, so the command may not have run')
    const denied = output.match(/\[moxy\] .*denied.*/)
    if (denied) result.notes.push(denied[0])
    result.ok = turn?.status === 'finished' && committed && wroteFiles && ranNode && !denied
  } catch (error) {
    result.notes.push(errorText(error))
  }
  return result
}

function cheapest(options: ModelOption[]): ModelOption | null {
  return options.find(option => CHEAP_MODEL.test(option.id) || CHEAP_MODEL.test(option.label)) ?? options[0] ?? null
}
