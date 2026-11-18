import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import type { Quota } from '../quota/quota.js'
import { TOOLS } from '../quota/usage.js'
import type { ToolId } from '../quota/usage.js'
import type { RunManager } from '../runs/manager.js'
import { present, summarize } from '../runs/present.js'
import { ENGINES } from '../runs/store.js'
import type { Run } from '../runs/store.js'

const WAIT_DEFAULT_SEC = 120
const WAIT_MAX_SEC = 600

const ok = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const fail = (error: unknown): CallToolResult => ({ content: [{ type: 'text', text: (error as Error).message }], isError: true })

async function guarded(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await work())
  } catch (error) {
    return fail(error)
  }
}

/**
 * Grip's tools for orchestrators. Any model that speaks MCP can delegate with them: start runs,
 * follow up, stop, and take finished results one at a time with `wait_any`.
 */
export function createGripMcpServer(manager: RunManager, quota: Quota, version = '0.0.0'): McpServer {
  const server = new McpServer({ name: 'grip', version })

  server.registerTool(
    'delegate',
    {
      title: 'Delegate a task to a worker',
      description:
        'Start a worker (Claude Code, Codex or Antigravity) on a task. Returns at once with the run; use wait_any to get the result. ' +
        'In a git repo the worker gets its own worktree on a grip/ branch; elsewhere it works in the folder itself. ' +
        'Give the brief as a file path (relative to folder, or absolute) or as text. ' +
        "Adds quotaNote when that engine's provider is low or out; the run starts either way.",
      inputSchema: {
        folder: z.string().describe('Absolute path of the folder or repo to work in'),
        engine: z.enum(ENGINES as [string, ...string[]]).describe('Which worker: claude, codex or agy'),
        brief_path: z.string().optional().describe('Path to a brief file describing the task'),
        brief_text: z.string().optional().describe('The task, written out, when there is no brief file'),
        model: z.string().optional().describe("Model for the worker; the engine's default when left out"),
        effort: z.string().optional().describe('Reasoning effort, where the engine supports it'),
        retry_of: z.string().optional().describe('Id of an earlier run this one redoes from its brief'),
      },
    },
    args =>
      guarded(async () => {
        const run = await manager.delegate({
          folder: args.folder,
          engine: args.engine as Run['engine'],
          brief: { ...(args.brief_path ? { path: args.brief_path } : {}), ...(args.brief_text ? { text: args.brief_text } : {}) },
          ...(args.model ? { model: args.model } : {}),
          ...(args.effort ? { effort: args.effort } : {}),
          ...(args.retry_of ? { retryOf: args.retry_of } : {}),
        })
        const quotaNote = quota.noteFor(run.engine)
        return { ...summarize(run), ...(quotaNote ? { quotaNote } : {}) }
      }),
  )

  server.registerTool(
    'message',
    {
      title: 'Send a follow-up to a run',
      description: 'Continue a run that has finished its turn, in the same conversation. Returns at once; use wait_any for the answer.',
      inputSchema: { run_id: z.string(), text: z.string().describe('What to tell the worker') },
    },
    args => guarded(async () => summarize(await manager.message(args.run_id, args.text))),
  )

  server.registerTool(
    'stop',
    {
      title: 'Stop a run',
      description: "Stop a run's current turn. Its worktree and history stay; it can be messaged again later.",
      inputSchema: { run_id: z.string() },
    },
    args => guarded(async () => summarize(await manager.stop(args.run_id))),
  )

  server.registerTool(
    'list',
    {
      title: 'List runs',
      description: 'Runs newest first. Unread means finished and not yet reviewed with result or wait_any.',
      inputSchema: {
        status: z.enum(['running', 'done', 'failed', 'stopped']).optional(),
        folder: z.string().optional().describe('Only runs started in this folder'),
      },
      annotations: { readOnlyHint: true },
    },
    args =>
      guarded(async () =>
        manager.list({ ...(args.status ? { status: args.status } : {}), ...(args.folder ? { folder: args.folder } : {}) }).map(summarize),
      ),
  )

  server.registerTool(
    'result',
    {
      title: "Read a run's result",
      description: "A run's brief, every turn's message and output, git facts, and its full diff against where it started. Marks it read.",
      inputSchema: { run_id: z.string() },
    },
    args => guarded(async () => present(await manager.details(args.run_id, { diff: true, markViewed: true }))),
  )

  server.registerTool(
    'wait_any',
    {
      title: 'Wait for the next finished run',
      description:
        'Return the next run that has finished (done or failed) and has not been read, with its full result, waiting up to timeout_sec. ' +
        'Returns null on timeout. Loop on this after delegating several tasks instead of polling each one.',
      inputSchema: {
        timeout_sec: z.number().int().min(0).max(WAIT_MAX_SEC).optional().describe(`Default ${WAIT_DEFAULT_SEC}, at most ${WAIT_MAX_SEC}`),
        run_ids: z.array(z.string()).optional().describe('Only wait for these runs'),
      },
    },
    (args, extra) =>
      guarded(async () => {
        const details = await manager.waitAny({
          timeoutMs: (args.timeout_sec ?? WAIT_DEFAULT_SEC) * 1000,
          ...(args.run_ids ? { ids: args.run_ids } : {}),
          signal: extra.signal,
        })
        return details ? present(details) : null
      }),
  )

  server.registerTool(
    'quota',
    {
      title: 'Read quota windows',
      description:
        'Quota windows (5-hour, weekly and others) for Codex, Antigravity and Claude, with a one-line verdict on the tightest one. ' +
        'Returns the last readings unless refresh is set. Refreshing Codex and Antigravity is free; Claude is read only when ' +
        'refresh names it, and that costs one tiny Claude turn.',
      inputSchema: {
        refresh: z
          .array(z.enum(TOOLS as [ToolId, ...ToolId[]]))
          .optional()
          .describe('Providers to read again before answering, for example ["codex", "agy"]'),
      },
    },
    args => guarded(async () => (args.refresh?.length ? quota.refresh(args.refresh) : quota.snapshot())),
  )

  return server
}
