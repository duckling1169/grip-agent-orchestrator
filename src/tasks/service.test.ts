import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it, onTestFinished } from 'vitest'

import { Database } from '../db/database.js'
import { MOXY_SCHEMA } from '../db/schema.js'
import { exec, execOk } from '../exec.js'
import { Integrator } from '../repos/integration.js'
import { Worktrees } from '../repos/worktrees.js'
import { FakeClaw } from '../testing/fake-claw.js'
import { silentLog, temporaryHome, temporaryRepo } from '../testing/harness.js'
import { sessionName, Workers } from '../workers/service.js'
import { WorkerStore } from '../workers/store.js'
import { Tasks } from './service.js'
import { TaskStore } from './store.js'

async function setup() {
  const path = join(await temporaryHome(), 'moxy.db')
  const repo = await temporaryRepo()
  const claw = new FakeClaw()
  let database = Database.open(path, MOXY_SCHEMA)
  onTestFinished(() => database.close())
  const open = () => {
    const worktrees = new Worktrees()
    const workers = new Workers({
      store: new WorkerStore(database),
      claw,
      worktrees,
      protectedFolders: [],
      isInstalled: () => true,
      log: silentLog,
    })
    return { workers, tasks: new Tasks({ store: new TaskStore(database), workers, worktrees, integrator: new Integrator() }) }
  }
  const services = open()
  const work = async (taskId: string, prompt: string, files: Record<string, string>) => {
    const worker = await services.tasks.delegate(taskId, { engine: 'claude', prompt })
    await claw.turnStarted(sessionName(worker.id))
    for (const [file, text] of Object.entries(files)) await writeFile(join(worker.cwd, file), text)
    claw.answer(sessionName(worker.id), { output: `Did: ${prompt}` })
    await services.workers.settled(worker.id)
    return worker
  }
  return {
    repo,
    claw,
    ...services,
    work,
    taskStore: () => new TaskStore(database),
    git: (...args: string[]) => execOk(exec, 'git', ['-C', repo, ...args]).then(out => out.trim()),
    restart: () => {
      database.close()
      database = Database.open(path, MOXY_SCHEMA)
      return open()
    },
  }
}

describe('Tasks', () => {
  it('integrates two tasks in one repo, survives a desktop edit and hands both to the user', async () => {
    const { repo, tasks, work, git } = await setup()
    const header = await tasks.create({ title: 'Add a header', folder: repo, testing: 'Refresh http://localhost:5173' })
    const footer = await tasks.create({ title: 'Add a footer', folder: join(repo, '.') })
    expect(header).toMatchObject({ status: 'working', repoRoot: repo })

    const headerWorker = await work(header.id, 'Add a header', { 'header.txt': 'header\n' })
    const footerWorker = await work(footer.id, 'Add a footer', { 'footer.txt': 'footer\n' })
    expect(tasks.get(header.id).workers.map(worker => worker.id)).toEqual([headerWorker.id])

    await writeFile(join(repo, 'README.md'), '# edited on the desktop\n')
    const refused = await tasks.integrate(header.id, headerWorker.id)
    expect(refused).toMatchObject({ status: 'refused', error: `${repo} has uncommitted changes: README.md` })
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('# edited on the desktop\n')

    await git('commit', '-qam', 'Desktop edit')
    const first = await tasks.integrate(header.id, headerWorker.id)
    expect(first).toMatchObject({ status: 'merged' })
    const readyHeader = await tasks.ready(header.id, { revision: String(first.revision), howToTry: 'Refresh the page' })
    expect(readyHeader).toMatchObject({ status: 'waiting', revision: first.revision, supersededBy: null })

    const second = await tasks.integrate(footer.id, footerWorker.id)
    expect(second).toMatchObject({ status: 'merged' })
    expect((await git('ls-files')).split('\n').sort()).toEqual(['README.md', 'footer.txt', 'header.txt'])
    expect(tasks.get(header.id).task.supersededBy).toBe(second.revision)

    expect(await tasks.integrate(footer.id, footerWorker.id)).toMatchObject({ status: 'merged', revision: second.revision })
  })

  it('runs integrations into one repo one at a time', async () => {
    const { repo, tasks, work, git } = await setup()
    const one = await tasks.create({ title: 'One', folder: repo })
    const two = await tasks.create({ title: 'Two', folder: repo })
    const [oneWorker, twoWorker] = [await work(one.id, 'One', { 'one.txt': '1\n' }), await work(two.id, 'Two', { 'two.txt': '2\n' })]

    const merged = await Promise.all([tasks.integrate(one.id, oneWorker.id), tasks.integrate(two.id, twoWorker.id)])
    expect(merged.map(integration => integration.status)).toEqual(['merged', 'merged'])
    expect(merged[1]?.revision).toBe(await git('rev-parse', 'HEAD'))
    expect((await git('ls-files')).split('\n').sort()).toEqual(['README.md', 'one.txt', 'two.txt'])
  })

  it('refuses a conflicting merge and leaves the checkout clean', async () => {
    const { repo, tasks, work, git } = await setup()
    const task = await tasks.create({ title: 'Rewrite the readme', folder: repo })
    const worker = await work(task.id, 'Rewrite the readme', { 'README.md': '# from the worker\n' })
    await writeFile(join(repo, 'README.md'), '# from the desktop\n')
    await git('commit', '-qam', 'Desktop edit')

    const refused = await tasks.integrate(task.id, worker.id)
    expect(refused).toMatchObject({ status: 'refused', error: `${worker.repo?.branch} conflicts with main in README.md` })
    expect(await git('status', '--porcelain')).toBe('')
  })

  it('refuses a checkout on another branch and a worker from another task', async () => {
    const { repo, tasks, work, git } = await setup()
    const task = await tasks.create({ title: 'One', folder: repo })
    const other = await tasks.create({ title: 'Two', folder: repo })
    const worker = await work(task.id, 'One', { 'one.txt': '1\n' })
    await expect(tasks.integrate(other.id, worker.id)).rejects.toThrow('does not belong to task')

    await git('switch', '-qc', 'elsewhere')
    expect(await tasks.integrate(task.id, worker.id)).toMatchObject({ status: 'refused', error: `${repo} is on elsewhere, not main` })
  })

  it('accepts only waiting work, and feedback reopens a task with the feedback in its notes', async () => {
    const { tasks } = await setup()
    const task = await tasks.create({ title: 'Write release notes' })
    expect(() => tasks.accept(task.id)).toThrow('is working; only a task waiting on the user can be accepted')
    await expect(tasks.ready(task.id, { revision: 'HEAD', howToTry: 'Read them' })).rejects.toThrow('has no revision')

    await tasks.ready(task.id, { howToTry: 'Read notes.md' })
    expect(tasks.reopen(task.id, 'Too long')).toMatchObject({ status: 'working', notes: 'Feedback: Too long' })
    await tasks.ready(task.id, { howToTry: 'Read notes.md' })
    expect(tasks.accept(task.id)).toMatchObject({ status: 'done' })
    expect(tasks.reopen(task.id, 'One more thing')).toMatchObject({
      status: 'working',
      notes: 'Feedback: Too long\n\nFeedback: One more thing',
    })
  })

  it('keeps tasks across a restart and marks an unfinished integration interrupted', async () => {
    const { repo, tasks, work, restart, taskStore } = await setup()
    const task = await tasks.create({ title: 'Keep me', folder: repo, plan: 'Small change' })
    const worker = await work(task.id, 'Keep me', { 'keep.txt': 'kept\n' })
    taskStore().startIntegration({ taskId: task.id, workerId: worker.id, repoRoot: repo, branch: String(worker.repo?.branch) })

    const restarted = restart()
    expect(restarted.tasks.reconcile()).toMatchObject([{ status: 'interrupted', workerId: worker.id }])
    expect(restarted.tasks.get(task.id)).toMatchObject({ task: { title: 'Keep me', plan: 'Small change' }, workers: [{ id: worker.id }] })
    expect(await restarted.tasks.integrate(task.id, worker.id)).toMatchObject({ status: 'merged' })
  })
})
