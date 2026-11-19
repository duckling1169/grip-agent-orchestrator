import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { ENGINES } from '../contracts/engines.js'
import { MOXY_MCP_NAME } from '../contracts/mcp.js'
import type { Engine } from '../contracts/engines.js'
import { errorText } from '../errors.js'
import type { ConversationStore } from '../moxy/store.js'
import type { Tasks } from '../tasks/service.js'
import type { Workers } from '../workers/service.js'
import type { Worker } from '../workers/store.js'

export type LeaderToolsDeps = { workers: Workers; tasks: Tasks; conversation: ConversationStore }

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
    status: worker.status,
    turns: worker.turnCount,
    cwd: worker.cwd,
    branch: worker.repo?.branch ?? null,
  }
}

export function createLeaderMcpServer({ workers, tasks, conversation }: LeaderToolsDeps, version: string): McpServer {
  const server = new McpServer({ name: MOXY_MCP_NAME, version })

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
        model: z.string().optional(),
        effort: z.string().optional(),
      },
    },
    ({ task_id, folder, ...rest }) =>
      asToolResult(async () => {
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
      title: 'Hand a task to the user',
      description:
        'Mark a reviewed and verified task as waiting on the user, with the revision to try (for repo tasks) and how to try it. ' +
        'Tell the user in your reply too.',
      inputSchema: {
        task_id: taskId,
        revision: z.string().optional().describe('The integrated commit the user tries'),
        how_to_try: z.string().describe("What to open or run, following the repo's usual testing workflow"),
      },
    },
    args => asToolResult(() => tasks.ready(args.task_id, { howToTry: args.how_to_try, revision: args.revision })),
  )

  server.registerTool(
    'accept',
    {
      title: 'Close an accepted task',
      description: 'Close a waiting task because the user said in this turn that it is done. Only works in a turn the user started.',
      inputSchema: { task_id: taskId },
    },
    args =>
      asToolResult(() => {
        if (!conversation.runningTurnStartedByUser())
          throw new Error('only the user can accept a task, and this turn did not start from a user message')
        return tasks.accept(args.task_id)
      }),
  )

  server.registerTool(
    'reopen',
    {
      title: 'Continue a task after feedback',
      description: "Set a waiting or done task back to working and add the user's feedback to its notes.",
      inputSchema: { task_id: taskId, feedback: z.string().describe("The user's feedback, in their terms") },
    },
    args => asToolResult(() => tasks.reopen(args.task_id, args.feedback)),
  )

  return server
}
