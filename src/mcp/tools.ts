import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { ENGINES } from '../contracts/engines.js'
import { MOXY_MCP_NAME } from '../contracts/mcp.js'
import type { Engine } from '../contracts/engines.js'
import { errorText } from '../errors.js'
import type { Workers } from '../workers/service.js'
import type { Worker } from '../workers/store.js'

const workerId = z.string().describe('A worker id from delegate or workers')

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
    title: worker.title,
    engine: worker.engine,
    model: worker.model,
    status: worker.status,
    turns: worker.turnCount,
    cwd: worker.cwd,
    branch: worker.repo?.branch ?? null,
  }
}

export function createLeaderMcpServer(workers: Workers, version: string): McpServer {
  const server = new McpServer({ name: MOXY_MCP_NAME, version })

  server.registerTool(
    'delegate',
    {
      title: 'Start a worker',
      description:
        'Start a coding worker on a task and return at once. In a git repo the worker gets its own worktree on a moxy/ branch; ' +
        'elsewhere it works in the folder. When its turn ends you receive a message about it, so end your turn instead of waiting.',
      inputSchema: {
        folder: z.string().describe('Absolute path of the folder or repo to work in'),
        engine: z.enum(ENGINES as [Engine, ...Engine[]]).describe('Which agent does the work'),
        prompt: z.string().describe('The task, written out in full'),
        title: z.string().optional().describe("Short name for the worker and its branch; defaults to the prompt's first line"),
        model: z.string().optional(),
        effort: z.string().optional(),
      },
    },
    args =>
      asToolResult(async () =>
        summarize(
          await workers.delegate({
            folder: args.folder,
            engine: args.engine,
            prompt: args.prompt,
            ...(args.title ? { title: args.title } : {}),
            ...(args.model ? { model: args.model } : {}),
            ...(args.effort ? { effort: args.effort } : {}),
          }),
        ),
      ),
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
    {
      title: 'List workers',
      description: 'Every worker, newest first, with its status and where it works.',
      annotations: { readOnlyHint: true },
    },
    () => asToolResult(() => workers.list().map(summarize)),
  )

  server.registerTool(
    'result',
    {
      title: "Read a worker's result",
      description: "Every turn's input and output, the files it changed, and its diff against where it started.",
      inputSchema: { worker_id: workerId, diff: z.boolean().optional().describe('Include the full diff; default true') },
      annotations: { readOnlyHint: true },
    },
    args =>
      asToolResult(async () => {
        const result = await workers.result(args.worker_id, { diff: args.diff ?? true })
        return { ...result, worker: summarize(result.worker) }
      }),
  )

  return server
}
