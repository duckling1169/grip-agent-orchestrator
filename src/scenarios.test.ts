/**
 * Scenario tests (DESIGN §16): one thing you would ask an orchestrator for each, done through
 * Grip's MCP tools in the order a model would call them, against a fake Claw. They check that
 * the tools are enough for the job, not how well a model uses them. An intent that cannot be
 * written this way is a missing feature.
 */
import { afterEach, expect, it } from 'vitest'

import { scriptedOrchestrator } from './testing/orchestrator.js'
import type { ScenarioOptions } from './testing/orchestrator.js'

const open: { close: () => Promise<void> }[] = []
afterEach(async () => {
  for (const o of open.splice(0)) await o.close()
})

async function orchestrator(options: ScenarioOptions = {}) {
  const o = await scriptedOrchestrator(options)
  open.push(o)
  return o
}

type Run = { id: string; engine: string; model: string | null; status: string; worktree: string | null; branch: string | null }
type Result = Run & {
  turns: { message: string; output: string | null }[]
  diff: { patch: string; untrackedFiles: string[] } | null
  overlaps: unknown[]
  error: string | null
}

it('sends a task to the engine with the most quota left', async () => {
  const o = await orchestrator({ quotaUsed: { claude: 95, codex: 60, agy: 20 } })
  const quota = await o.call<{ providers: { provider: string; windows: { usedPercent: number }[] }[] }>('quota', {
    refresh: ['claude', 'codex', 'agy'],
  })
  const left = quota.providers.map(p => ({ engine: p.provider, left: 100 - Math.max(...p.windows.map(w => w.usedPercent)) }))
  const best = left.sort((a, b) => b.left - a.left)[0]!.engine
  expect(best).toBe('agy')

  const run = await o.call<Run>('delegate', { folder: o.repo, engine: best, brief_text: 'Fix the login bug', chat_title: 'Login' })
  await o.worker(run.id).finish('Fixed.')
  const result = await o.call<Result>('wait_any', { timeout_sec: 5 })
  expect(result).toMatchObject({ id: run.id, engine: 'agy', status: 'done' })
})

it('picks a strong model, and the run records which one worked', async () => {
  const o = await orchestrator()
  const lists = await o.call<{ engine: string; models: { id: string; efforts: string[] }[] }[]>('models', { engine: 'claude' })
  const strongest = lists[0]!.models.find(m => m.efforts.includes('max'))!
  const run = await o.call<Run>('delegate', {
    folder: o.repo,
    engine: 'claude',
    model: strongest.id,
    effort: 'max',
    brief_text: 'Design the cache',
  })
  expect(run).toMatchObject({ model: 'claude-opus-5-5' })
  await expect(o.call('delegate', { folder: o.repo, engine: 'codex', model: 'gpt-7', brief_text: 'X' })).rejects.toThrow(
    'Unknown codex model "gpt-7"',
  )
})

it('runs a council: the same question to three engines, then a round where each sees the others', async () => {
  const o = await orchestrator()
  const question = 'Should the login bug be fixed in the client or the server? Answer in one paragraph.'
  const members = []
  for (const engine of ['claude', 'codex', 'agy'])
    members.push(await o.call<Run>('delegate', { folder: o.repo, engine, brief_text: question, title: `Council: ${engine}` }))

  const answers = new Map<string, string>()
  await Promise.all(members.map(m => o.worker(m.id).finish(`${m.engine} says: server`)))
  for (let i = 0; i < members.length; i++) {
    const r = await o.call<Result>('wait_any', { timeout_sec: 5, run_ids: members.map(m => m.id) })
    answers.set(r.id, r.turns.at(-1)!.output!)
  }
  expect(answers.size).toBe(3)

  // Round two: each member reads the others' answers in its own conversation.
  for (const m of members) {
    const others = [...answers].filter(([id]) => id !== m.id).map(([, answer]) => answer)
    await o.call('message', { run_id: m.id, text: `Others said:\n${others.join('\n')}\nDo you agree?` })
  }
  await Promise.all(members.map(m => o.worker(m.id).finish('Agreed: server.')))
  const final = []
  for (let i = 0; i < members.length; i++) final.push(await o.call<Result>('wait_any', { timeout_sec: 5, run_ids: members.map(m => m.id) }))
  expect(final.map(r => r.turns.at(-1)!.output)).toEqual(['Agreed: server.', 'Agreed: server.', 'Agreed: server.'])
  expect(o.sentTo(members[0]!.id).at(-1)).toContain('codex says: server')
})

it('stops everything it started', async () => {
  const o = await orchestrator()
  for (const brief_text of ['Refactor auth', 'Upgrade deps'])
    await o.call('delegate', { folder: o.repo, engine: 'claude', brief_text, chat_title: 'Cleanup' })
  const running = await o.call<Run[]>('list', { status: 'running' })
  expect(running).toHaveLength(2)
  for (const run of running) await o.call('stop', { run_id: run.id })
  await expect(o.call<Run[]>('list', { status: 'running' })).resolves.toEqual([])
  await expect(o.call<Run[]>('list', { status: 'stopped' })).resolves.toHaveLength(2)
})

it('retries a failed task on another engine without rewriting the brief', async () => {
  const o = await orchestrator()
  const first = await o.call<Run>('delegate', { folder: o.repo, engine: 'codex', brief_text: 'Add a rate limiter' })
  await o.worker(first.id).fail('codex crashed')
  const failed = await o.call<Result>('wait_any', { timeout_sec: 5 })
  expect(failed).toMatchObject({ id: first.id, status: 'failed' })

  const retry = await o.call<Run & { retryOf: string }>('delegate', { retry_of: first.id, engine: 'claude' })
  expect(retry).toMatchObject({ engine: 'claude', retryOf: first.id })
  await o.worker(retry.id).finish('Done.')
  const result = await o.call<Result & { brief: { text: string } }>('result', { run_id: retry.id })
  expect(result.brief.text).toBe('Add a rate limiter')
})

it('reviews a worker’s uncommitted new file and gets the branch to merge', async () => {
  const o = await orchestrator()
  const run = await o.call<Run>('delegate', { folder: o.repo, engine: 'claude', brief_text: 'Add a changelog' })
  await o.worker(run.id).edit('CHANGELOG.md', '# Changes\n- Fixed login\n')
  await o.worker(run.id).finish('Added CHANGELOG.md.')
  const result = await o.call<Result>('wait_any', { timeout_sec: 5 })
  expect(result.diff?.patch).toContain('+- Fixed login')
  expect(result.branch).toMatch(/^grip\//)
  expect(result.worktree).toBeTruthy()
})

it('warns when two finished workers changed the same file, until one is merged', async () => {
  const o = await orchestrator()
  const a = await o.call<Run>('delegate', { folder: o.repo, engine: 'claude', brief_text: 'Fix login on the client' })
  const b = await o.call<Run>('delegate', { folder: o.repo, engine: 'codex', brief_text: 'Fix login on the server' })
  await o.worker(a.id).edit('src/login.ts', 'export const login = () => true // client\n')
  await o.worker(b.id).edit('src/login.ts', 'export const login = () => true // server\n')
  await o.worker(a.id).finish('Done.')
  await o.worker(b.id).finish('Done.')
  const result = await o.call<Result>('result', { run_id: a.id })
  expect(result.overlaps).toEqual([{ runId: b.id, title: 'Fix login on the server', files: ['src/login.ts'], running: false }])

  // Once the server fix is merged, the client fix clashes with main instead, which git reports.
  o.worker(b.id).commit('Fix login on the server')
  o.git('merge', '-q', b.branch!)
  await expect(o.call<Result>('result', { run_id: a.id })).resolves.toMatchObject({ overlaps: [] })
})

it('says plainly when the chosen engine is not installed', async () => {
  const o = await orchestrator({ installed: ['claude', 'codex', 'agy'] })
  await expect(o.call('delegate', { folder: o.repo, engine: 'kimi', brief_text: 'Fix it' })).rejects.toThrow(
    'Kimi is not installed on this machine',
  )
})

it('tells a working worker from a stuck one', async () => {
  const o = await orchestrator()
  const run = await o.call<Run>('delegate', { folder: o.repo, engine: 'claude', brief_text: 'Rewrite login' })
  await o.worker(run.id).edit('src/login.ts', 'export const login = () => true\n')
  const [listed] = await o.call<(Run & { activity?: { lastEdit: { file: string } | null; changedFiles: number } })[]>('list', {
    status: 'running',
  })
  expect(listed?.activity).toMatchObject({ lastEdit: { file: 'src/login.ts' }, changedFiles: 1 })
})

it('changes a working worker’s course: stop it, then tell it what to do instead', async () => {
  const o = await orchestrator()
  const run = await o.call<Run>('delegate', { folder: o.repo, engine: 'codex', brief_text: 'Fix login in the client' })
  await expect(o.call('message', { run_id: run.id, text: 'Do it on the server' })).rejects.toThrow('still working')
  await o.call('stop', { run_id: run.id })
  await o.call('message', { run_id: run.id, text: 'Fix it on the server instead' })
  await o.worker(run.id).finish('Fixed on the server.')
  const result = await o.call<Result>('wait_any', { timeout_sec: 5 })
  expect(result.turns.map(t => t.message)).toEqual(['Fix login in the client', 'Fix it on the server instead'])
  // The same conversation continues.
  expect(o.claw.starts.at(-1)?.name).toBe(`grip-${run.id}`)
})

it('hands a worker a brief the orchestrator wrote to a file', async () => {
  const o = await orchestrator()
  const { writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  await writeFile(join(o.repo, 'brief-cache.md'), '# Add a response cache\n\nCache GET /users for 60 s.\n')
  const run = await o.call<Run & { title: string }>('delegate', { folder: o.repo, engine: 'agy', brief_path: 'brief-cache.md' })
  expect(run.title).toBe('Add a response cache')
  await o.worker(run.id).finish('Done.')
  expect(o.sentTo(run.id)[0]).toContain('brief-cache.md')
})
