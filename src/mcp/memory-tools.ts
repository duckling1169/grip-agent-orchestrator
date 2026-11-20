import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import type { ConversationHistory } from '../moxy/history.js'
import { MEMORY_LIMITS } from '../moxy/memory.js'
import type { Memory } from '../moxy/memory.js'
import { PROJECT_NOTE_LIMIT } from '../moxy/notes.js'
import type { ProjectNotes } from '../moxy/notes.js'

const readOnly = { annotations: { readOnlyHint: true } }

type MemoryToolsDeps = {
  memory: Memory
  notes: ProjectNotes
  history: ConversationHistory
}

export function registerMemoryTools(
  server: McpServer,
  { memory, notes, history }: MemoryToolsDeps,
  asToolResult: (work: () => unknown) => Promise<CallToolResult>,
): void {
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
    'notes_read',
    {
      title: 'Read project notes',
      description: 'Read lasting notes for a repository, or list repositories that have saved notes.',
      inputSchema: { repo: z.string().optional().describe('A folder in the repository; omit to list saved notes') },
      ...readOnly,
    },
    ({ repo }) => asToolResult(() => (repo === undefined ? notes.list() : notes.read(repo))),
  )
  server.registerTool(
    'notes_update',
    {
      title: 'Update project notes',
      description: 'Replace a repository note with short lasting context and decisions. Pass an empty body to delete it.',
      inputSchema: {
        repo: z.string().describe('A folder in the repository'),
        body: z.string().max(PROJECT_NOTE_LIMIT),
      },
    },
    ({ repo, body }) => asToolResult(() => notes.update(repo, body)),
  )
  server.registerTool(
    'history_search',
    {
      title: 'Search conversation history',
      description: 'Search earlier user and Moxy messages by space-separated words and optional ISO date bounds.',
      inputSchema: {
        words: z.string(),
        since: z.string().optional(),
        until: z.string().optional(),
        limit: z.number().int().min(1).max(10).optional(),
      },
      ...readOnly,
    },
    args => asToolResult(() => history.search(args)),
  )
  server.registerTool(
    'history_read',
    {
      title: 'Read conversation around a hit',
      description: 'Read a message by ref from history_search along with surrounding messages in timeline order.',
      inputSchema: {
        ref: z.string(),
        around: z.number().int().min(0).max(10).optional(),
      },
      ...readOnly,
    },
    args => asToolResult(() => history.read(args)),
  )
}
