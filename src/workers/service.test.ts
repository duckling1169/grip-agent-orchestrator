import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it, onTestFinished } from 'vitest'

import { Database } from '../db/database.js'
import { MOXY_SCHEMA } from '../db/schema.js'
import { Worktrees } from '../repos/worktrees.js'
import { FakeClaw } from '../testing/fake-claw.js'
import { silentLog, temporaryHome, temporaryRepo } from '../testing/harness.js'
import { sessionName, Workers } from './service.js'
import { WorkerStore } from './store.js'

async function setup(options: { installed?: boolean } = {}) {
  const home = await temporaryHome()
  const databasePath = join(home, 'moxy.db')
  const protectedFolder = join(home, 'protected')
  const claw = new FakeClaw()
  let database = Database.open(databasePath, MOXY_SCHEMA)
  onTestFinished(() => database.close())
  const workersOn = (db: Database) =>
    new Workers({
      store: new WorkerStore(db),
      claw,
      worktrees: new Worktrees(),
      protectedFolders: [protectedFolder],
      isInstalled: () => options.installed ?? true,
      log: silentLog,
    })
  return {
    home,
    claw,
    protectedFolder,
    workers: workersOn(database),
    store: () => new WorkerStore(database),
    restart: () => {
      database.close()
      database = Database.open(databasePath, MOXY_SCHEMA)
      return workersOn(database)
    },
  }
}

describe('Workers', () => {
  it('delegates in a git repo to its own worktree and records the finished turn', async () => {
    const { claw, workers } = await setup()
    const repo = await temporaryRepo()
    const worker = await workers.delegate({ folder: repo, engine: 'claude', prompt: '# Add a feature\nDetails follow.', model: 'opus' })

    expect(worker).toMatchObject({ title: 'Add a feature', status: 'running', turnCount: 1 })
    expect(worker.repo?.branch).toMatch(/^moxy\/claude-add-a-feature-[0-9a-f]{8}$/)
    expect(worker.cwd.startsWith(`${repo}-worktrees`)).toBe(true)

    await claw.turnStarted(sessionName(worker.id))
    expect(claw.starts[0]).toMatchObject({
      cwd: worker.cwd,
      engine: 'claude',
      permissionMode: 'auto',
      model: 'opus',
      disallowedTools: ['mcp__moxy'],
    })
    await writeFile(join(worker.cwd, 'feature.txt'), 'new\n')
    claw.answer(sessionName(worker.id), { output: 'Added the feature.', sessionId: 'native-1' })
    await workers.settled(worker.id)

    const result = await workers.result(worker.id, { diff: true })
    expect(result.worker).toMatchObject({ status: 'finished', nativeSessionId: 'native-1' })
    expect(result.turns).toMatchObject([
      { number: 1, model: 'opus', input: '# Add a feature\nDetails follow.', output: 'Added the feature.' },
    ])
    expect(result.facts?.changedFiles).toEqual(['feature.txt'])
    expect(result.diff?.patch).toContain('feature.txt')
    expect(claw.stops).toContain(sessionName(worker.id))
  })

  it('works directly in a folder outside any repo', async () => {
    const { claw, workers, home } = await setup()
    const folder = join(home, 'notes')
    await mkdir(folder)
    const worker = await workers.delegate({ folder, engine: 'codex', prompt: 'Tidy the notes' })

    await claw.turnStarted(sessionName(worker.id))
    expect(worker.repo).toBeNull()
    expect(claw.starts[0]).toMatchObject({ engine: 'codex-app' })
    expect(claw.starts[0]?.permissionMode).toBeUndefined()
    expect((await workers.result(worker.id)).facts).toBeNull()
  })

  it('resumes the native conversation for a follow-up and refuses one while working', async () => {
    const { claw, workers } = await setup()
    const worker = await workers.delegate({ folder: await temporaryRepo(), engine: 'claude', prompt: 'Start' })
    await claw.turnStarted(sessionName(worker.id))
    expect(() => workers.message(worker.id, 'Too soon')).toThrow('still finishing')

    claw.answer(sessionName(worker.id), { output: 'Started.', sessionId: 'native-1' })
    await workers.settled(worker.id)
    expect(workers.message(worker.id, 'Continue')).toMatchObject({ status: 'running', turnCount: 2 })
    await claw.turnStarted(sessionName(worker.id))
    expect(claw.starts[1]).toMatchObject({ resumeSessionId: 'native-1' })
  })

  it('stops a running turn and keeps it stopped', async () => {
    const { claw, workers } = await setup()
    const worker = await workers.delegate({ folder: await temporaryRepo(), engine: 'claude', prompt: 'Long work' })
    await claw.turnStarted(sessionName(worker.id))

    expect(await workers.stop(worker.id)).toMatchObject({ status: 'stopped' })
    await workers.settled(worker.id)
    const result = await workers.result(worker.id)
    expect(result.worker.status).toBe('stopped')
    expect(result.turns[0]?.error).toBeNull()
  })

  it('records a failed turn with its error', async () => {
    const { claw, workers } = await setup()
    const worker = await workers.delegate({ folder: await temporaryRepo(), engine: 'claude', prompt: 'Work' })
    await claw.turnStarted(sessionName(worker.id))
    claw.fail(sessionName(worker.id), new Error('usage limit reached'))
    await workers.settled(worker.id)

    expect((await workers.result(worker.id)).turns[0]).toMatchObject({ status: 'failed', error: 'usage limit reached' })
  })

  it('refuses protected folders, missing folders, empty prompts and engines that are not installed', async () => {
    const { workers, protectedFolder, home } = await setup()
    await mkdir(join(protectedFolder, 'inside'), { recursive: true })
    await expect(workers.delegate({ folder: join(protectedFolder, 'inside'), engine: 'claude', prompt: 'x' })).rejects.toThrow('protected')
    await expect(workers.delegate({ folder: join(home, 'missing'), engine: 'claude', prompt: 'x' })).rejects.toThrow('folder not found')
    await expect(workers.delegate({ folder: home, engine: 'claude', prompt: '  ' })).rejects.toThrow('prompt is required')

    const { workers: withoutEngines } = await setup({ installed: false })
    await expect(withoutEngines.delegate({ folder: home, engine: 'grok', prompt: 'x' })).rejects.toThrow('Grok is not installed')
  })
})

describe('Workers.reconcile after a restart', () => {
  it('interrupts a turn recorded before its worktree or session existed', async () => {
    const { store, restart } = await setup()
    store().create(
      { id: 'intent01', title: 'Planned', engine: 'claude', model: null, effort: null, folder: '/x', cwd: '/x', repo: null },
      'Do it',
    )

    const workers = restart()
    expect((await workers.reconcile()).interruptedTurns).toEqual([{ workerId: 'intent01', number: 1 }])
    expect((await workers.result('intent01')).turns[0]).toMatchObject({ status: 'interrupted', error: 'Moxy restarted during this turn' })
  })

  it('interrupts a turn that was running in Claw and stops its session', async () => {
    const { claw, workers, restart } = await setup()
    const worker = await workers.delegate({ folder: await temporaryRepo(), engine: 'claude', prompt: 'Work' })
    await claw.turnStarted(sessionName(worker.id))

    const restarted = restart()
    expect(await restarted.reconcile()).toEqual({ interruptedTurns: [{ workerId: worker.id, number: 1 }], orphanedSessions: [] })
    expect(claw.sessions.has(sessionName(worker.id))).toBe(false)
    expect((await restarted.result(worker.id)).worker.status).toBe('interrupted')
  })

  it('leaves finished turns alone and reports sessions no worker owns', async () => {
    const { claw, workers, restart } = await setup()
    const worker = await workers.delegate({ folder: await temporaryRepo(), engine: 'claude', prompt: 'Work' })
    await claw.turnStarted(sessionName(worker.id))
    claw.answer(sessionName(worker.id), { output: 'Done.' })
    await workers.settled(worker.id)
    await claw.startSession({ name: sessionName('deadbeef'), cwd: '/x', engine: 'claude' })

    const restarted = restart()
    expect(await restarted.reconcile()).toEqual({ interruptedTurns: [], orphanedSessions: [sessionName('deadbeef')] })
    expect((await restarted.result(worker.id)).worker.status).toBe('finished')
  })

  it('marks running turns interrupted when Moxy stops', async () => {
    const { claw, workers } = await setup()
    const worker = await workers.delegate({ folder: await temporaryRepo(), engine: 'claude', prompt: 'Work' })
    await claw.turnStarted(sessionName(worker.id))

    expect(workers.interruptAll()).toEqual([{ workerId: worker.id, number: 1 }])
    await claw.stopSession(sessionName(worker.id))
    await workers.idle()
    expect((await workers.result(worker.id)).turns[0]).toMatchObject({ status: 'interrupted', error: 'Moxy stopped during this turn' })
  })
})
