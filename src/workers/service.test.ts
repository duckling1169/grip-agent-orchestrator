import { mkdir, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it, onTestFinished } from 'vitest'

import { PLAIN_COMMANDS_RULE } from '../contracts/engines.js'
import { Database } from '../db/database.js'
import { MOXY_SCHEMA } from '../db/schema.js'
import { exec, execOk } from '../exec.js'
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
  const ended: string[] = []
  const workersOn = (db: Database) =>
    new Workers({
      store: new WorkerStore(db),
      claw,
      worktrees: new Worktrees(),
      protectedFolders: [protectedFolder],
      isInstalled: () => options.installed ?? true,
      log: silentLog,
      onTurnEnded: (worker, turn) => ended.push(`${worker.id}:${turn.number}:${turn.status}`),
    })
  return {
    ended,
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
    expect(claw.starts[0]?.appendSystemPrompt).toContain(PLAIN_COMMANDS_RULE)
    expect(claw.starts[0]).not.toHaveProperty('settings')
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

  it('starts and resumes agy with only the workspace and its Git paths writable', async () => {
    const { claw, workers } = await setup()
    const repo = await temporaryRepo()
    const worker = await workers.delegate({ folder: repo, engine: 'agy', prompt: 'Read and update the checkout' })
    const name = sessionName(worker.id)
    expect(worker.repo?.branch).toBe(`moxy/agy-read-and-update-the-checkout-${worker.id}/work`)
    const common = join(repo, '.git')
    const branchDir = `agy-read-and-update-the-checkout-${worker.id}`
    const settings = {
      enableTerminalSandbox: true,
      toolPermission: 'proceed-in-sandbox',
      permissions: {
        allow: [
          `write_file(${worker.cwd})`,
          `read_file(${common})`,
          `write_file(${join(common, 'worktrees', branchDir)})`,
          `write_file(${join(common, 'objects')})`,
          `write_file(${join(common, 'refs', 'heads', 'moxy', branchDir)})`,
          `write_file(${join(common, 'logs', 'refs', 'heads', 'moxy', branchDir)})`,
        ],
        deny: [`write_file(${join(common, 'objects', 'info')})`, `write_file(${join(common, 'objects', 'pack')})`],
      },
    }
    await claw.turnStarted(name)
    expect(claw.starts[0]).toMatchObject({ cwd: worker.cwd, engine: 'agy', permissionMode: 'dontAsk', settings: JSON.stringify(settings) })
    claw.answer(name, { output: 'Done', sessionId: 'agy-native' })
    await workers.settled(worker.id)

    await execOk(exec, 'git', ['-C', repo, 'pack-refs', '--all'])
    const refDirectory = join(common, 'refs', 'heads', 'moxy', branchDir)
    await expect(stat(refDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    workers.message(worker.id, 'Continue')
    await claw.turnStarted(name)
    expect(claw.starts[1]).toMatchObject({ resumeSessionId: 'agy-native', settings: JSON.stringify(settings) })
    expect((await stat(refDirectory)).isDirectory()).toBe(true)
    claw.answer(name, { output: 'Done' })
    await workers.settled(worker.id)
  })

  it('fails agy launch if a metadata directory resolves outside the checkout’s Git directory', async () => {
    const { claw, workers, protectedFolder } = await setup()
    const repo = await temporaryRepo()
    const worker = await workers.delegate({ folder: repo, engine: 'agy', prompt: 'Work' })
    const name = sessionName(worker.id)
    await claw.turnStarted(name)
    claw.answer(name, { output: 'Done' })
    await workers.settled(worker.id)

    const reflogDir = join(repo, '.git', 'logs', 'refs', 'heads', ...worker.repo!.branch.split('/').slice(0, -1))
    await rm(join(reflogDir, 'work'), { force: true })
    await rmdir(reflogDir)
    await mkdir(protectedFolder)
    await symlink(protectedFolder, reflogDir, process.platform === 'win32' ? 'junction' : 'dir')
    workers.message(worker.id, 'Continue')
    await workers.settled(worker.id)
    expect(claw.starts).toHaveLength(1)
    expect(workers.detail(worker.id).turns.at(-1)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/permission|protected/i),
    })
  })

  it('grants an agy worker outside Git only its checkout and refuses a checkout containing a protected folder', async () => {
    const { claw, workers, home, protectedFolder } = await setup()
    const folder = join(home, 'notes')
    await mkdir(folder)
    await mkdir(protectedFolder)
    const worker = await workers.delegate({ folder, engine: 'agy', prompt: 'Edit the notes' })
    const name = sessionName(worker.id)
    await claw.turnStarted(name)
    expect(JSON.parse(claw.starts[0]!.settings!).permissions).toEqual({ allow: [`write_file(${worker.cwd})`], deny: [] })
    claw.answer(name, { output: 'Done' })
    await workers.settled(worker.id)

    const blocked = await workers.delegate({ folder: home, engine: 'agy', prompt: 'Edit the notes' })
    await workers.settled(blocked.id)
    expect(workers.detail(blocked.id).turns[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('protected folder') })
    expect(claw.starts).toHaveLength(1)
  })

  it('reports the current step while running and the changed files', async () => {
    const { claw, workers } = await setup()
    const worker = await workers.delegate({ folder: await temporaryRepo(), engine: 'claude', prompt: 'Edit the notes' })
    await claw.turnStarted(sessionName(worker.id))
    const edit = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: join(worker.cwd, 'notes.md') } }] },
    }
    claw.events.set(sessionName(worker.id), [{ time: '2026-11-19T10:00:00.000Z', type: 'output', content: JSON.stringify(edit) }])
    await writeFile(join(worker.cwd, 'notes.md'), 'notes\n')

    expect(await workers.activity(worker.id)).toMatchObject({
      step: { text: 'Editing notes.md', at: '2026-11-19T10:00:00.000Z' },
      changedFiles: ['notes.md'],
    })

    claw.answer(sessionName(worker.id), { output: 'Done.' })
    await workers.settled(worker.id)
    expect(await workers.activity(worker.id)).toMatchObject({ step: null, changedFiles: ['notes.md'] })
  })

  it('works directly in a folder outside any repo', async () => {
    const { claw, workers, home } = await setup()
    const folder = join(home, 'notes')
    await mkdir(folder)
    const worker = await workers.delegate({ folder, engine: 'codex', prompt: 'Tidy the notes' })

    await claw.turnStarted(sessionName(worker.id))
    expect(worker.repo).toBeNull()
    expect(claw.starts[0]).toMatchObject({ engine: 'codex-app', sandboxMode: 'danger-full-access' })
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
    const { store, restart, ended } = await setup()
    store().create(
      { id: 'intent01', taskId: null, title: 'Planned', engine: 'claude', model: null, effort: null, folder: '/x', cwd: '/x', repo: null },
      'Do it',
    )

    const workers = restart()
    expect((await workers.reconcile()).interruptedTurns).toEqual([{ workerId: 'intent01', number: 1 }])
    expect((await workers.result('intent01')).turns[0]).toMatchObject({ status: 'interrupted', error: 'Moxy restarted during this turn' })
    expect(ended).toEqual(['intent01:1:interrupted'])
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
