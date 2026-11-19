import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { ENGINES } from '../contracts/engines.js'
import { MOXY_MCP_NAME } from '../contracts/mcp.js'
import type { Engine } from '../contracts/engines.js'
import { errorText } from '../errors.js'
import type { Tasks } from '../tasks/service.js'
import type { Workers } from '../workers/service.js'
import type { Worker } from '../contracts/api.js'
import { checkModelChoice } from '../providers/models.js'
import type { ModelCatalog } from '../providers/models.js'
import type { Quota } from '../providers/quota.js'
import { FOLLOW_UP_PROMPT_LIMIT } from '../moxy/follow-ups.js'
import type { FollowUps } from '../moxy/follow-ups.js'
import { MEMORY_LIMITS } from '../moxy/memory.js'
import type { Memory } from '../moxy/memory.js'

export type LeaderToolsDeps = {
  workers: Workers
  tasks: Tasks
  models: Pick<ModelCatalog, 'get'>
  quota: Pick<Quota, 'snapshot'>
  followUps: FollowUps
  memory: Memory
}

const workerId = z.string().describe('A worker id from delegate or workers')
const taskId = z.string().describe('A task id from task_create or tasks')
const readOnly = { annotations: { readOnlyHint: true } }

async function asToolResult(work: () => unknown): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await work(), null, 2) }] }
  } catch (error) {
    return { content: [{ type: 'text', text: errorText(error) }], isError: true }
  }
}

function summarize(worker: Worker) {
  return {
    id: worker.id,
    task: worker.taskId,
    title: worker.title,
    engine: worker.engine,
    model: worker.model,
    effort: worker.effort,
    status: worker.status,
    turns: worker.turnCount,
    cwd: worker.cwd,
    branch: worker.repo?.branch ?? null,
  }
}

export function createLeaderMcpServer({ workers, tasks, models, quota, followUps, memory }: LeaderToolsDeps, version: string): McpServer {
  const server = new McpServer({ name: MOXY_MCP_NAME, version })

  server.registerTool(
    'memory_read',
    {
      title: 'Read user memory',
      description: 'Standing instructions and durable preferences shared across tasks. Keep pointers rather than copies of repo contents.',
      ...readOnly,
    },
    () => asToolResult(() => memory.read()),
  )
  server.registerTool(
    'memory_update',
    {
      title: 'Update user memory',
      description:
        'Replace standing instructions or durable preference notes. Store only preferences and corrections, never credentials or repo content that can be read again.',
      inputSchema: {
        instructions: z.string().max(MEMORY_LIMITS.instructions).optional(),
        preferences: z.string().max(MEMORY_LIMITS.preferences).optional(),
      },
    },
    update => asToolResult(() => memory.update(update)),
  )
  server.registerTool(
    'follow_up',
    {
      title: 'Schedule a follow-up',
      description:
        'Schedule a future inbox message, such as checking a task when quota resets, cancel a pending timer, or list pending timers. A follow-up is not a new user message and cannot accept tasks.',
      inputSchema: {
        action: z.enum(['schedule', 'cancel', 'list']),
        due_at: z.string().optional(),
        prompt: z.string().max(FOLLOW_UP_PROMPT_LIMIT).optional(),
        id: z.string().optional(),
      },
    },
    args =>
      asToolResult(() => {
        if (args.action === 'list') return followUps.list().filter(timer => timer.status === 'pending')
        if (args.action === 'cancel') {
          if (!args.id) throw new Error('id is required to cancel a follow-up')
          return followUps.cancel(args.id)
        }
        if (!args.due_at || !args.prompt) throw new Error('due_at and prompt are required to schedule a follow-up')
        return followUps.schedule({ dueAt: args.due_at, prompt: args.prompt })
      }),
  )

  server.registerTool(
    'models',
    {
      title: 'List provider models',
      description: 'Discover the models and effort levels reported by this engine. Opening an ACP session sends no prompt.',
      inputSchema: { engine: z.enum(ENGINES as [Engine, ...Engine[]]) },
      ...readOnly,
    },
    ({ engine }) => asToolResult(() => models.get(engine)),
  )

  server.registerTool(
    'quota',
    {
      title: 'Read provider quota',
      description: 'Cached provider quota windows with observation time, staleness and errors. Does not spend a Claude probe turn.',
      ...readOnly,
    },
    () => asToolResult(() => quota.snapshot()),
  )

  server.registerTool(
    'task_create',
    {
      title: 'Create a task',
      description: 'Record a piece of work the user asked for, with its repo, agreed plan and how it is tested. Tasks start working.',
      inputSchema: {
        title: z.string(),
        folder: z.string().optional().describe('A folder in the repo the task changes; omit for work outside any repo'),
        plan: z.string().optional(),
        testing: z.string().optional().describe("How this repo's changes are tried, such as the URL to refresh"),
      },
    },
    args => asToolResult(() => tasks.create(args)),
  )

  server.registerTool(
    'task_update',
    {
      title: 'Update task notes',
      description: 'Replace any of the title, plan, notes (decisions, rejected approaches) or testing notes.',
      inputSchema: {
        task_id: taskId,
        title: z.string().optional(),
        plan: z.string().optional(),
        notes: z.string().optional(),
        testing: z.string().optional(),
      },
    },
    ({ task_id, ...notes }) => asToolResult(() => tasks.update(task_id, notes)),
  )

  server.registerTool(
    'task_get',
    {
      title: 'Read a task',
      description: "A task's notes, its workers and its integrations.",
      inputSchema: { task_id: taskId },
      ...readOnly,
    },
    args =>
      asToolResult(() => {
        const detail = tasks.get(args.task_id)
        return { ...detail, workers: detail.workers.map(summarize) }
      }),
  )

  server.registerTool('tasks', { title: 'List tasks', description: 'Every task, most recently changed first.', ...readOnly }, () =>
    asToolResult(() =>
      tasks
        .list()
        .map(({ id, title, status, repoRoot, revision, supersededBy }) => ({ id, title, status, repoRoot, revision, supersededBy })),
    ),
  )

  server.registerTool(
    'delegate',
    {
      title: 'Start a worker',
      description:
        'Start a coding worker and return at once. In a git repo the worker gets its own worktree on a moxy/ branch; elsewhere it ' +
        'works in the folder. Give task_id so the worker belongs to a task. When its turn ends you receive a message about it, so end ' +
        'your turn instead of waiting.',
      inputSchema: {
        task_id: taskId.optional(),
        folder: z.string().optional().describe("Absolute path to work in; defaults to the task's repo"),
        engine: z.enum(ENGINES as [Engine, ...Engine[]]).describe('Which agent does the work'),
        prompt: z.string().describe('The task, written out in full'),
        title: z.string().optional().describe("Short name for the worker and its branch; defaults to the prompt's first line"),
        model: z
          .string()
          .optional()
          .describe('Required when the models tool lists models for this engine. Pick one; never rely on a default'),
        effort: z
          .string()
          .optional()
          .describe('Required when the model offers effort levels. Higher effort spends much more quota; use it only for hard work'),
      },
    },
    ({ task_id, folder, ...rest }) =>
      asToolResult(async () => {
        checkModelChoice(await models.get(rest.engine), rest.model, rest.effort)
        if (task_id) return summarize(await tasks.delegate(task_id, { ...rest, folder }))
        if (!folder) throw new Error('give a folder or a task_id')
        return summarize(await workers.delegate({ ...rest, folder }))
      }),
  )

  server.registerTool(
    'message',
    {
      title: 'Send a worker a follow-up',
      description:
        'Continue a worker that has finished its turn, in the same conversation. Returns at once; you receive a message when it ends.',
      inputSchema: { worker_id: workerId, text: z.string().describe('What to tell the worker') },
    },
    args => asToolResult(() => summarize(workers.message(args.worker_id, args.text))),
  )

  server.registerTool(
    'stop',
    {
      title: 'Stop a worker',
      description: "Stop a worker's current turn. Its worktree and history stay, and it can be messaged again.",
      inputSchema: { worker_id: workerId },
    },
    async args => asToolResult(async () => summarize(await workers.stop(args.worker_id))),
  )

  server.registerTool(
    'workers',
    { title: 'List workers', description: 'Every worker, newest first, with its task, status and where it works.', ...readOnly },
    () => asToolResult(() => workers.list().map(summarize)),
  )

  server.registerTool(
    'result',
    {
      title: "Read a worker's result",
      description: "Every turn's input and output, the files it changed, and its diff against where it started.",
      inputSchema: { worker_id: workerId, diff: z.boolean().optional().describe('Include the full diff; default true') },
      ...readOnly,
    },
    args =>
      asToolResult(async () => {
        const result = await workers.result(args.worker_id, { diff: args.diff ?? true })
        return { ...result, worker: summarize(result.worker) }
      }),
  )

  server.registerTool(
    'integrate',
    {
      title: "Merge a worker's branch",
      description:
        "Commit the worker's remaining changes and merge its branch into the repo's main checkout, one integration per repo at a time. " +
        'Refused, and left untouched, when the checkout has uncommitted changes, is on another branch, or conflicts; resolve that with ' +
        'a worker or a question, then integrate again. Verify the combined result before calling ready.',
      inputSchema: { task_id: taskId, worker_id: workerId },
    },
    args => asToolResult(() => tasks.integrate(args.task_id, args.worker_id)),
  )

  server.registerTool(
    'ready',
    {
      title: 'Finish a task',
      description:
        'Mark a reviewed and verified task as done, with the revision to try (for repo tasks) and how to try it. The user gets a ' +
        'notification; tell them in your reply too.',
      inputSchema: {
        task_id: taskId,
        revision: z.string().optional().describe('The integrated commit the user tries'),
        how_to_try: z.string().describe("What to open or run, following the repo's usual testing workflow"),
      },
    },
    args => asToolResult(() => tasks.ready(args.task_id, { howToTry: args.how_to_try, revision: args.revision })),
  )

  server.registerTool(
    'reopen',
    {
      title: 'Continue a task after feedback',
      description: "Set a done task back to working and add the user's feedback to its notes.",
      inputSchema: { task_id: taskId, feedback: z.string().describe("The user's feedback, in their terms") },
    },
    args => asToolResult(() => tasks.reopen(args.task_id, args.feedback)),
  )

  return server
}
