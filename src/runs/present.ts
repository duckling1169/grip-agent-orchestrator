import type { RunDetails } from './manager.js'
import type { Run } from './store.js'

const EARLIER_OUTPUT_CHARS = 2000

/** The short form of a run in lists and acknowledgements. */
export function summarize(run: Run) {
  return {
    id: run.id,
    title: run.title,
    engine: run.engine,
    model: run.model,
    effort: run.effort,
    status: run.status,
    error: run.error,
    folder: run.folder,
    worktree: run.repo?.worktree ?? null,
    branch: run.repo?.branch ?? null,
    turns: run.turns,
    chatId: run.chatId,
    /** Not yet read by its orchestrator. */
    unread: !run.viewed,
    /** Not yet opened in the app. */
    unseen: !run.seen,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    retryOf: run.retryOf,
  }
}

/** A finished run as an orchestrator reviews it: the last output in full, earlier ones clipped. */
export function present(details: RunDetails) {
  const last = details.turns.length
  return {
    ...summarize(details.run),
    brief: details.run.brief.kind === 'path' ? { path: details.run.brief.path } : { text: details.run.brief.text },
    turns: details.turns.map(t => ({
      turn: t.turn,
      // Messages you sent the worker yourself, so its chat knows you stepped in (design §5.1).
      from: details.run.fromUser.includes(t.turn) ? ('user' as const) : ('orchestrator' as const),
      message: t.message,
      output:
        t.turn === last || !t.output || t.output.length <= EARLIER_OUTPUT_CHARS ? t.output : `${t.output.slice(0, EARLIER_OUTPUT_CHARS)}…`,
    })),
    git: details.facts,
    diff: details.diff && {
      stat: details.diff.stat,
      untrackedFiles: details.diff.untrackedFiles,
      patch: details.diff.patch,
      truncated: details.diff.truncated,
    },
    overlaps: details.overlaps,
  }
}
