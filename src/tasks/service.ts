import { randomBytes } from 'node:crypto'

import { errorText } from '../errors.js'
import { samePath } from '../repos/folders.js'
import type { Integrator } from '../repos/integration.js'
import type { Worktrees } from '../repos/worktrees.js'
import type { DelegateInput, Workers } from '../workers/service.js'
import type { Worker } from '../workers/store.js'
import type { Integration, Task, TaskNotes, TaskStore } from './store.js'

export type NewTask = { title: string; folder?: string; plan?: string; testing?: string }

export type TaskDetail = { task: Task; workers: Worker[]; integrations: Integration[] }

export type TaskDelegation = Omit<DelegateInput, 'taskId' | 'folder'> & { folder?: string }

export type TasksOptions = { store: TaskStore; workers: Workers; worktrees: Worktrees; integrator: Integrator }

export class Tasks {
  constructor(private readonly options: TasksOptions) {}

  private get store(): TaskStore {
    return this.options.store
  }

  async create(input: NewTask): Promise<Task> {
    const title = input.title.trim()
    if (!title) throw new Error('a title is required')
    const repo = input.folder
      ? await this.options.worktrees.repoOf(input.folder).catch(() => {
          throw new Error(`folder not found: ${input.folder}`)
        })
      : null
    return this.store.create({
      id: randomBytes(4).toString('hex'),
      title,
      repoRoot: repo?.root ?? null,
      plan: input.plan ?? '',
      testing: input.testing ?? '',
    })
  }

  update(id: string, notes: TaskNotes): Task {
    if (notes.title !== undefined && !notes.title.trim()) throw new Error('a title cannot be empty')
    return this.store.update(id, notes)
  }

  get(id: string): TaskDetail {
    return { task: this.store.mustGet(id), workers: this.options.workers.listForTask(id), integrations: this.store.integrations(id) }
  }

  list(): Task[] {
    return this.store.list()
  }

  async delegate(taskId: string, input: TaskDelegation): Promise<Worker> {
    const task = this.store.mustGet(taskId)
    if (task.status === 'done') throw new Error(`task ${taskId} is done; reopen it first`)
    const folder = input.folder ?? task.repoRoot
    if (!folder) throw new Error(`task ${taskId} has no repo, so the worker needs a folder`)
    if (task.repoRoot) {
      const repo = await this.options.worktrees.repoOf(folder).catch(() => null)
      if (!repo || !samePath(repo.root, task.repoRoot)) throw new Error(`${folder} is not in task ${taskId}'s repo ${task.repoRoot}`)
    }
    const worker = await this.options.workers.delegate({ ...input, folder, taskId })
    this.store.setStatus(taskId, 'working', ['waiting'])
    return worker
  }

  async integrate(taskId: string, workerId: string): Promise<Integration> {
    this.store.mustGet(taskId)
    const worker = this.options.workers.get(workerId)
    if (worker.taskId !== taskId) throw new Error(`worker ${workerId} does not belong to task ${taskId}`)
    if (!worker.repo) throw new Error(`worker ${workerId} did not work in a git repo, so there is nothing to integrate`)
    if (worker.status === 'running') throw new Error(`worker ${workerId} is still working; wait for it or stop it first`)
    const repo = worker.repo
    const id = this.store.startIntegration({ taskId, workerId, repoRoot: repo.root, branch: repo.branch })
    let revision: string
    try {
      revision = await this.options.integrator.integrate({
        repoRoot: repo.root,
        base: repo.base,
        branch: repo.branch,
        worktree: worker.cwd,
        title: worker.title,
      })
    } catch (error) {
      return this.store.endIntegration(id, { status: 'refused', revision: null, error: errorText(error) })
    }
    const merged = this.store.endIntegration(id, { status: 'merged', revision, error: null })
    this.store.supersedeWaiting(repo.root, revision)
    return merged
  }

  async ready(taskId: string, delivery: { revision?: string; howToTry: string }): Promise<Task> {
    const task = this.store.mustGet(taskId)
    const howToTry = delivery.howToTry.trim()
    if (!howToTry) throw new Error('say how the user can try it')
    if (task.repoRoot && !delivery.revision) throw new Error(`task ${taskId} is in ${task.repoRoot}, so give the revision to try`)
    if (!task.repoRoot && delivery.revision) throw new Error(`task ${taskId} has no repo, so it has no revision`)
    const revision = task.repoRoot && delivery.revision ? await this.options.worktrees.commit(task.repoRoot, delivery.revision) : null
    return this.store.deliver(taskId, revision, howToTry)
  }

  accept(taskId: string): Task {
    const accepted = this.store.setStatus(taskId, 'done', ['waiting'])
    if (accepted) return accepted
    throw new Error(`task ${taskId} is ${this.store.mustGet(taskId).status}; only a task waiting on the user can be accepted`)
  }

  reopen(taskId: string, feedback: string): Task {
    const note = feedback.trim()
    if (!note) throw new Error('feedback is required')
    return this.store.reopen(taskId, `Feedback: ${note}`)
  }

  reconcile(): Integration[] {
    return this.store.interruptRunningIntegrations('Moxy restarted during this integration; check the checkout for an unfinished merge')
  }
}
