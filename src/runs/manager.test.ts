import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { Worktrees } from '../git/worktrees.js'
import { RunManager } from './manager.js'
import { RunStore } from './store.js'
import { FakeClaw } from '../testing/fake-claw.js'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=grip-test', '-c', 'user.email=grip@test', '-C', cwd, ...args], { encoding: 'utf8' }).trim()

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function setup() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'grip-mgr-')))
  dirs.push(base)
  const repo = join(base, 'app')
  await mkdir(join(repo, 'docs'), { recursive: true })
  git(base, 'init', '-q', '-b', 'main', repo)
  await writeFile(join(repo, 'README.md'), 'app\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'init')
  // An uncommitted brief, as an orchestrator would leave it.
  await writeFile(join(repo, 'docs', 'brief-login.md'), '# Fix the login bug\n\nDetails…\n')
  const plain = join(base, 'notes')
  await mkdir(plain)

  const store = await RunStore.open(join(base, 'grip-home'))
  const claw = new FakeClaw()
  const activity: number[] = []
  const killed = { count: 0 }
  const manager = new RunManager({
    store,
    worktrees: new Worktrees(),
    claw,
    onActivityChange: n => activity.push(n),
    killWorkers: async () => {
      killed.count++
      claw.hangStops = false
      for (const s of [...claw.sessions.keys()]) await claw.stopSession(s)
    },
  })
  return { base, repo, plain, store, claw, manager, activity, killed }
}

describe('delegate', () => {
  it('runs Claude and agy workers in auto mode, so shell commands are not refused unasked', async () => {
    const t = await setup()
    for (const engine of ['agy', 'claude'] as const) {
      const run = await t.manager.delegate({ folder: t.plain, engine, brief: { text: 'Run the tests' } })
      await t.claw.waitForSend(run.session)
      expect(t.claw.starts.at(-1)).toMatchObject({ engine, permissionMode: 'auto' })
      t.claw.answer(run.session, { output: 'ok' })
      await t.manager.settled(run.id)
    }
  })

  it('gives a repo run its own worktree, starts a Claw session there, and records the result', async () => {
    const t = await setup()
    const run = await t.manager.delegate({ folder: t.repo, engine: 'codex', brief: { path: 'docs/brief-login.md' }, model: 'gpt-6.1' })
    expect(run).toMatchObject({ title: 'Fix the login bug', status: 'running', engine: 'codex' })
    expect(run.repo?.branch).toBe('grip/codex-fix-the-login-bug')
    expect(run.cwd).toBe(run.repo?.worktree)

    await t.claw.waitForSend(run.session)
    expect(t.claw.starts[0]).toMatchObject({ name: run.session, cwd: run.cwd, engine: 'codex-app', model: 'gpt-6.1' })
    // Codex runs in its own sandbox with no prompts; it takes no permission mode.
    expect(t.claw.starts[0]?.permissionMode).toBeUndefined()
    expect(t.claw.sends[0]?.message).toBe(`Do the work described in ${join(t.repo, 'docs', 'brief-login.md')}.`)

    await writeFile(join(run.cwd, 'fix.ts'), 'export {}\n')
    t.claw.answer(run.session, { output: 'Fixed it.', sessionId: 'thread-1' })
    await t.manager.settled(run.id)

    const after = t.store.get(run.id)!
    expect(after).toMatchObject({ status: 'done', turns: 1, engineSessionId: 'thread-1', viewed: false })
    // The session is closed between turns.
    expect(t.claw.sessions.size).toBe(0)
    expect(t.activity.at(-1)).toBe(0)

    const details = await t.manager.details(run.id, { diff: true })
    expect(details.turns[0]?.output).toBe('Fixed it.')
    expect(details.facts?.changedFiles).toEqual(['fix.ts'])
    expect(details.diff?.untrackedFiles).toEqual(['fix.ts'])
  })

  it('runs in the folder itself when it is not a repo, and takes text briefs', async () => {
    const t = await setup()
    const run = await t.manager.delegate({
      folder: t.plain,
      engine: 'agy',
      brief: { text: '## Check the DNS settings\nand say what is wrong' },
    })
    expect(run).toMatchObject({ title: 'Check the DNS settings', cwd: t.plain, repo: null })
    await t.claw.waitForSend(run.session)
    expect(t.claw.sends[0]?.message).toBe('## Check the DNS settings\nand say what is wrong')
  })

  it('refuses protected folders, missing folders and bad briefs', async () => {
    const t = await setup()
    const sshDir = join(homedir(), '.ssh')
    await expect(t.manager.delegate({ folder: t.plain, engine: 'claude', brief: {} })).rejects.toThrow('a brief is required')
    await expect(t.manager.delegate({ folder: t.repo, engine: 'claude', brief: { path: 'nope.md' } })).rejects.toThrow('brief not found')
    await expect(t.manager.delegate({ folder: join(t.base, 'missing'), engine: 'claude', brief: { text: 'x' } })).rejects.toThrow(
      'folder not found',
    )
    await mkdir(sshDir, { recursive: true }).catch(() => undefined)
    await expect(t.manager.delegate({ folder: sshDir, engine: 'claude', brief: { text: 'x' } })).rejects.toThrow('protected folder')
  })

  it('records a turn that fails to start as failed', async () => {
    const t = await setup()
    t.claw.startSession = async () => {
      throw new Error('/session/start: Internal error')
    }
    const run = await t.manager.delegate({ folder: t.plain, engine: 'claude', brief: { text: 'x' } })
    await t.manager.settled(run.id)
    expect(t.store.get(run.id)).toMatchObject({ status: 'failed', error: '/session/start: Internal error' })
  })
})

describe('message, stop and wait', () => {
  it('resumes the same engine conversation for a follow-up', async () => {
    const t = await setup()
    const run = await t.manager.delegate({ folder: t.plain, engine: 'claude', brief: { text: 'first' } })
    await t.claw.waitForSend(run.session)
    await expect(t.manager.message(run.id, 'too soon')).rejects.toThrow('still working')
    t.claw.answer(run.session, { output: 'one', sessionId: 'conv-9' })
    await t.manager.settled(run.id)

    await t.manager.message(run.id, 'second')
    await t.claw.waitForSend(run.session)
    expect(t.claw.starts[1]?.resumeSessionId).toBe('conv-9')
    t.claw.answer(run.session, { output: 'two', permissionDenials: [{ toolName: 'Bash' }] })
    await t.manager.settled(run.id)
    const details = await t.manager.details(run.id)
    expect(details.turns.map(x => x.output)).toEqual(['one', 'two\n\n[grip] 1 tool call(s) were denied: Bash'])
  })

  it('stops a run and keeps it stopped when the turn returns late', async () => {
    const t = await setup()
    const run = await t.manager.delegate({ folder: t.plain, engine: 'codex', brief: { text: 'long job' } })
    await t.claw.waitForSend(run.session)
    expect((await t.manager.stop(run.id)).status).toBe('stopped')
    await t.manager.settled(run.id)
    expect(t.store.get(run.id)?.status).toBe('stopped')
  })

  it('stops all runs through Claw when it answers', async () => {
    const t = await setup()
    const a = await t.manager.delegate({ folder: t.plain, engine: 'codex', brief: { text: 'A' } })
    const b = await t.manager.delegate({ folder: t.plain, engine: 'agy', brief: { text: 'B' } })
    await t.claw.waitForSend(a.session)
    await t.claw.waitForSend(b.session)
    const result = await t.manager.stopAll()
    expect(result.killed).toBe(false)
    expect(result.stopped.map(r => r.status)).toEqual(['stopped', 'stopped'])
    expect(t.activity.at(-1)).toBe(0)
    expect((await t.manager.stopAll()).stopped).toEqual([])
  })

  it('kills every worker when Claw does not stop a session in time', async () => {
    const t = await setup()
    const run = await t.manager.delegate({ folder: t.plain, engine: 'claude', brief: { text: 'stuck' } })
    await t.claw.waitForSend(run.session)
    t.claw.hangStops = true
    const result = await t.manager.stopAll({ graceMs: 50 })
    expect(result).toMatchObject({ killed: true, stopped: [{ id: run.id, status: 'stopped' }] })
    expect(t.killed.count).toBe(1)
    await t.manager.settled(run.id)
    expect(t.store.get(run.id)?.status).toBe('stopped')
  })

  it('hands finished runs to waitAny one at a time and marks them viewed', async () => {
    const t = await setup()
    const a = await t.manager.delegate({ folder: t.plain, engine: 'claude', brief: { text: 'A' } })
    const b = await t.manager.delegate({ folder: t.repo, engine: 'agy', brief: { text: 'B' } })
    await t.claw.waitForSend(a.session)
    await t.claw.waitForSend(b.session)

    const waiting = t.manager.waitAny({ timeoutMs: 2000 })
    t.claw.answer(b.session, { output: 'B done' })
    const first = await waiting
    expect(first?.run).toMatchObject({ id: b.id, viewed: true })
    expect(first?.diff?.stat).toBe('')

    t.claw.answer(a.session, { output: '', error: 'turn timed out' })
    const second = await t.manager.waitAny({ timeoutMs: 2000 })
    expect(second?.run).toMatchObject({ id: a.id, status: 'failed', error: 'turn timed out' })
    expect(await t.manager.waitAny({ timeoutMs: 20 })).toBeNull()
  })

  it('warns when two active runs in one repo touch the same file', async () => {
    const t = await setup()
    const a = await t.manager.delegate({ folder: t.repo, engine: 'claude', brief: { text: 'A' } })
    const b = await t.manager.delegate({ folder: t.repo, engine: 'codex', brief: { text: 'B' } })
    await writeFile(join(a.cwd, 'README.md'), 'changed by a\n')
    await writeFile(join(b.cwd, 'README.md'), 'changed by b\n')
    const details = await t.manager.details(a.id)
    expect(details.overlaps).toEqual([{ runId: b.id, title: 'B', files: ['README.md'] }])
  })

  it('deletes a working run: stops it, hides it, and keeps it deleted after a restart', async () => {
    const t = await setup()
    const run = await t.manager.delegate({ folder: t.repo, engine: 'claude', brief: { text: 'Doomed' } })
    await t.claw.waitForSend(run.session)
    expect(await t.manager.delete(run.id)).toEqual({ deleted: run.id })
    expect(t.claw.sessions.size).toBe(0)
    await t.manager.settled(run.id)
    expect(t.store.get(run.id)).toBeNull()
    expect(t.manager.list()).toEqual([])
    // Its worktree stays, so the app can still list and remove it.
    expect(t.store.list({ deleted: true }).map(r => r.id)).toEqual([run.id])
    expect(await t.manager.waitAny({ timeoutMs: 20 })).toBeNull()
    const reopened = await RunStore.open(join(t.base, 'grip-home'))
    expect(reopened.get(run.id)).toBeNull()
    expect(reopened.isDeleted(run.id)).toBe(true)
  })

  it('renames a run', async () => {
    const t = await setup()
    const run = await t.manager.delegate({ folder: t.plain, engine: 'agy', brief: { text: 'Old name' } })
    expect((await t.manager.rename(run.id, 'New name')).title).toBe('New name')
    const reopened = await RunStore.open(join(t.base, 'grip-home'))
    expect(reopened.get(run.id)?.title).toBe('New name')
  })

  it('recovers after a restart: stuck runs fail and their sessions close', async () => {
    const t = await setup()
    const run = await t.manager.delegate({ folder: t.plain, engine: 'claude', brief: { text: 'x' } })
    await t.claw.waitForSend(run.session)
    const fresh = new RunManager({ store: t.store, worktrees: new Worktrees(), claw: t.claw })
    expect((await fresh.recover()).map(r => r.id)).toEqual([run.id])
    expect(t.store.get(run.id)).toMatchObject({ status: 'failed', error: 'grip restarted' })
    expect(t.claw.sessions.size).toBe(0)
  })
})
