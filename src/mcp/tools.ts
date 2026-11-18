import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import type { ModelCatalog } from '../models.js'
import type { Quota } from '../quota/quota.js'
import { TOOLS } from '../quota/usage.js'
import type { ToolId } from '../quota/usage.js'
import type { RunManager } from '../runs/manager.js'
import { present, summarize } from '../runs/present.js'
import { ENGINES } from '../runs/store.js'
import type { Run } from '../runs/store.js'
import type { McpChats } from './http.js'

const WAIT_DEFAULT_SEC = 120
const WAIT_MAX_SEC = 600
/**
 * Waits end by this, whatever was asked: MCP clients give up on a tool call after a few minutes
 * (Claude Code at about 7), and a call that times out leaves the orchestrator unsure what happened.
 * A null answer just means call again.
 */
const WAIT_CAP_SEC = 240

export type McpCaller = { chatId?: string; host?: string; chats?: McpChats }

/** Each agent's models, as the app's pickers show them. */
export type McpModels = Pick<ModelCatalog, 'list'>

// A hosted chat can have more than one MCP session.
const waitsByChatManager = new WeakMap<McpChats, Map<string, number>>()

const ok = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const fail = (error: unknown): CallToolResult => ({ content: [{ type: 'text', text: (error as Error).message }], isError: true })

async function guarded(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await work())
  } catch (error) {
    return fail(error)
  }
}

async function whileWaiting<T>(chats: McpChats | undefined, chatId: string | undefined, wait: () => Promise<T>): Promise<T> {
  if (!chats || !chatId) return wait()
  let counts = waitsByChatManager.get(chats)
  if (!counts) {
    counts = new Map()
    waitsByChatManager.set(chats, counts)
  }
  const active = (counts.get(chatId) ?? 0) + 1
  counts.set(chatId, active)
  try {
    if (active === 1) chats.setWaiting(chatId, true)
    return await wait()
  } finally {
    const remaining = counts.get(chatId)! - 1
    if (remaining > 0) {
      counts.set(chatId, remaining)
    } else {
      counts.delete(chatId)
      chats.setWaiting(chatId, false)
    }
  }
}

/**
 * Refuse a model the engine's own CLI does not list, before a run starts and fails on it. Only
 * Codex and Antigravity are checked: their lists come from the CLI itself, while Claude's is
 * Grip's own and may lag behind (Claude Code also takes aliases such as `opus`). An engine
 * whose list cannot be read is not checked. Antigravity also takes a model without its effort
 * suffix, and Claw's `agy/` prefix.
 */
export async function checkModel(models: McpModels, engine: Run['engine'], model: string): Promise<void> {
  if (engine === 'claude') return
  const list = (await models.list()).find(entry => entry.engine === engine)
  if (!list || list.error || list.models.length === 0) return
  const ids = list.models.map(option => option.id)
  const wanted = engine === 'agy' ? model.replace(/^agy\//, '') : model
  const known = ids.includes(wanted) || (engine === 'agy' && ids.some(id => id.startsWith(`${wanted}-`)))
  if (!known)
    throw new Error(`Unknown ${engine} model "${model}". Use an id from the models tool, for example: ${ids.slice(0, 5).join(', ')}.`)
}

/**
 * Grip's tools for orchestrators. Any model that speaks MCP can delegate with them: start runs,
 * follow up, stop, and take finished results one at a time with `wait_any`.
 */
export function createGripMcpServer(
  manager: RunManager,
  quota: Quota,
  version = '0.0.0',
  caller: McpCaller = {},
  models?: McpModels,
): McpServer {
  const server = new McpServer(
    { name: 'grip', version },
    {
      instructions:
        'Use delegate to start workers asynchronously. Call models first and pass a model to delegate, so the run records which one works. Give your chat a short descriptive chat_title on the first delegation. ' +
        'Use wait_any to review completed workers in your chat. To pick up work from another chat, find the runs with list and pass ' +
        'their IDs as run_ids to wait_any, or read a specific run with result.',
    },
  )

  let creatingChat: Promise<string> | undefined

  async function chatForDelegation(folder: string, title?: string): Promise<string | undefined> {
    const { chats } = caller
    if (!chats) return caller.chatId
    // You deleted this session's chat in the app; its next delegation starts a new one.
    if (caller.chatId && caller.host && !chats.get(caller.chatId)) caller.chatId = undefined
    if (!caller.chatId && !creatingChat) {
      // Concurrent first delegations must use the same chat creation.
      creatingChat = chats.externalChat({ folder, host: caller.host, title }).then(chat => {
        caller.chatId = chat.id
        return chat.id
      })
      try {
        return await creatingChat
      } finally {
        creatingChat = undefined
      }
    }
    const chatId = caller.chatId ?? (await creatingChat)
    if (title && chatId) await chats.rename(chatId, title)
    return chatId
  }

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
        folder: z.string().optional().describe("Absolute path of the folder or repo to work in. A retry defaults to the old run's folder."),
        engine: z.enum(ENGINES as [string, ...string[]]).describe('Which worker: claude, codex or agy'),
        brief_path: z.string().optional().describe('Path to a brief file describing the task'),
        brief_text: z.string().optional().describe('The task, written out, when there is no brief file'),
        model: z
          .string()
          .optional()
          .describe(
            'Model id from the models tool. Choose one: left out, the agent picks its own default, and Grip cannot tell which one ran.',
          ),
        effort: z.string().optional().describe("Reasoning effort: one of the chosen model's efforts from the models tool"),
        retry_of: z
          .string()
          .optional()
          .describe(
            "Id of an earlier run to redo from scratch, with its brief, folder and title unless you give new ones. To continue a run's own conversation instead, use message.",
          ),
        title: z.string().optional().describe("Short name for this run and its branch. Defaults to the brief's first line."),
        chat_title: z.string().optional().describe('Short title for this chat in Grip'),
      },
    },
    args =>
      guarded(async () => {
        if (args.model && models) await checkModel(models, args.engine as Run['engine'], args.model)
        const folder = args.folder ?? (args.retry_of ? manager.list().find(run => run.id === args.retry_of)?.folder : undefined)
        if (!folder) throw new Error('a folder is required')
        const chatId = await chatForDelegation(folder, args.chat_title?.trim())
        const run = await manager.delegate({
          folder,
          engine: args.engine as Run['engine'],
          ...(args.title ? { title: args.title } : {}),
          brief: { ...(args.brief_path ? { path: args.brief_path } : {}), ...(args.brief_text ? { text: args.brief_text } : {}) },
          ...(args.model ? { model: args.model } : {}),
          ...(args.effort ? { effort: args.effort } : {}),
          ...(args.retry_of ? { retryOf: args.retry_of } : {}),
          ...(chatId ? { chatId } : {}),
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
      description:
        'Runs newest first. Unread means finished and not yet reviewed with result or wait_any. ' +
        'A running run in a repo has activity: its newest edit, last commit and how many files changed, to tell a working run from a stuck one.',
      inputSchema: {
        status: z.enum(['running', 'done', 'failed', 'stopped']).optional(),
        folder: z.string().optional().describe('Only runs started in this folder'),
      },
      annotations: { readOnlyHint: true },
    },
    args =>
      guarded(async () => {
        const runs = manager.list({ ...(args.status ? { status: args.status } : {}), ...(args.folder ? { folder: args.folder } : {}) })
        return Promise.all(
          runs.map(async run => {
            const activity = run.status === 'running' ? await manager.activity(run) : null
            return { ...summarize(run), ...(activity ? { activity } : {}) }
          }),
        )
      }),
  )

  server.registerTool(
    'result',
    {
      title: "Read a run's result",
      description: "A run's brief, every turn's message and output, git facts, and its full diff against where it started. Marks it read.",
      inputSchema: { run_id: z.string() },
      annotations: { destructiveHint: false },
    },
    args => guarded(async () => present(await manager.details(args.run_id, { diff: true, markViewed: true }))),
  )

  server.registerTool(
    'wait_any',
    {
      title: 'Wait for the next finished run',
      description:
        'Return the next run that has finished (done or failed) and has not been read, with its full result, waiting up to timeout_sec. ' +
        'Waits for runs in this chat by default. Pass run_ids to wait for specific runs from any chat. ' +
        `Returns null on timeout; a single call waits at most ${WAIT_CAP_SEC} seconds, so call it again to keep waiting.`,
      inputSchema: {
        timeout_sec: z.number().int().min(0).max(WAIT_MAX_SEC).optional().describe(`Default ${WAIT_DEFAULT_SEC}, at most ${WAIT_MAX_SEC}`),
        run_ids: z.array(z.string()).optional().describe('Only wait for these runs'),
      },
      annotations: { destructiveHint: false },
    },
    (args, extra) =>
      guarded(async () => {
        const { chats, chatId } = caller
        if (extra.signal.aborted || (chats && !chatId && !args.run_ids)) return null
        const details = await whileWaiting(chats, chatId, () =>
          manager.waitAny({
            timeoutMs: Math.min(args.timeout_sec ?? WAIT_DEFAULT_SEC, WAIT_CAP_SEC) * 1000,
            ...(args.run_ids ? { ids: args.run_ids } : { chatId }),
            signal: extra.signal,
          }),
        )
        return details ? present(details) : null
      }),
  )

  if (models)
    server.registerTool(
      'models',
      {
        title: 'List the models each worker can use',
        description:
          'Models for each engine (claude, codex, agy): the id to pass to delegate as model, its name, the efforts it takes and its default effort. ' +
          'Codex and Antigravity lists come from their own CLIs; an engine whose list cannot be read has an error instead. ' +
          'Antigravity ids carry their effort in the name (for example -high), so they take no separate effort.',
        inputSchema: {
          engine: z
            .enum(ENGINES as [string, ...string[]])
            .optional()
            .describe('Only this engine'),
        },
      },
      args => guarded(async () => (await models.list()).filter(list => !args.engine || list.engine === args.engine)),
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
