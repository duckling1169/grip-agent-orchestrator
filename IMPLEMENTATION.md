# Moxy implementation plan

[DESIGN.md](DESIGN.md) owns product behavior. This document owns how Moxy is built. Moxy is built from the ground up in a git worktree. The existing code is reference material only: copy a module when it already does the job well, rename it to fit, and delete everything else.

## Principles

- One daemon, one SQLite file, one leader conversation. No second runtime, broker, workflow engine or agent framework.
- Claw runs workers. Moxy adds tasks, worktrees, integration, device access and quota. Do not rebuild Claw's execution kernel.
- Review is a leader turn, not a stored lifecycle. The leader reads results and runs checks; heavier review is another worker with a review prompt.
- The leader finishes a task with `ready` once it has reviewed, integrated and verified the work. The user's feedback reopens it.
- Record intent before every external call (Claw, Git), and reconcile after a restart. Never promise exactly-once; never launch a duplicate silently.
- No legacy code, deprecated paths, compatibility shims, aliases or migrations from earlier versions. Moxy has no history to stay compatible with.
- Name things well and keep code DRY. Add an abstraction only when two real callers need it.
- No explanatory code comments. Names, types and small functions explain the code. Always credit the source of copied or adapted code, ideas and designs.

## Decisions

- **Runtime:** Node 24 LTS; `engines` and CI move together. One package, one daemon.
- **Storage:** SQLite through `node:sqlite`, one writer, short transactions. Turn text lives in SQLite; diffs come from git. Anything large later kept on disk is written before the row that references it. Config and secrets stay files. Day-one spike: transactions, restart and Windows packaging. If `node:sqlite` fails the spike, use `better-sqlite3`.
- **Claw:** depend on the `>=7.23.4 <8` range, with startup compatibility checks and crash restart. No automatic updates; upgrading is an explicit command.
- **Leaders:** Claude leaders run through Claw; other leaders run through ACP directly so they receive session-scoped MCP tools. Keep the Codex ACP adapter.
- **Web:** `node:http`, SSE and the existing React/Vite/Tailwind/shadcn stack. Shared Zod schemas live in a browser-safe `contracts/` folder. Add Hono, TanStack Query or a router only for a demonstrated need.
- **Tests:** Vitest with the fake Claw and fake ACP agent; a few Playwright journeys against the fake preview. Automated tests never call real models.
- **Not adopted:** XState, LangGraph, an ORM, a DI framework, a plugin loader, generic base classes.

## How it works

### The turn loop

Everything the leader reacts to goes into a durable **inbox**: user messages, worker finished/failed, quota errors and integration results. The daemon runs one leader turn at a time, and a turn's message puts user messages before worker events. Starting a turn assigns every pending item to it in one transaction. A finished or failed turn keeps its items; a turn interrupted by a stop or crash releases them, and they are delivered again with a note that the earlier turn was cut off. The conversation is the user's inbox items plus the leader turns; there is no separate messages table.

Each turn takes every pending item, so several quick user messages get one reply. Items carry a source ID (`user:<id>`, `worker:<id>:<turn>`), and a repeated ID is ignored, so the same completion cannot be recorded twice. Items that arrive during a turn wait for the next one.

Long work never runs inside a leader turn. The leader delegates, then the turn ends. A worker's completion arrives later as a new inbox item. This keeps the conversation responsive without per-task leader sessions.

### Timers

The leader can set a follow-up for a time ("retry when Claude's quota resets at 15:00", "check this worker in an hour"). Timers are rows with a due time. A scheduler turns each due timer into an inbox item and marks it done; a timer never starts a turn by itself. Quota recovery uses the same timers instead of polling.

### Memory

Task notes hold one task's progress. Moxy also keeps memory that applies to every task: the user's standing instructions, loaded on every leader turn, and notes about the user's preferences and corrections, which the leader reads and updates through tools. Store only what cannot be looked up again; keep pointers to repos, files and revisions rather than copies. Keep the per-turn overhead (instructions, tool definitions, memory) small and stable so providers can cache it.

### Tasks

A task is a row: repo, title, plan and decisions, testing notes, and status `working` or `done` (with the delivered revision and how to try it). The UI splits `working` into Working while a worker runs and Reviewing while the leader has the finished work. Feedback on a `done` task sets it back to `working` and is appended to its notes; a `done` task takes no new workers until it is reopened. Workers belong to a task, or stand alone when the user starts one directly; a task's workers must work in the task's repo.

The leader keeps task detail out of its own context. It reads and writes task notes through tools, so a fresh native session can be rebuilt from the task rows and recent messages.

### Workers

`delegate` records the worker and its first turn in one transaction (engine, model, effort, task and the planned worktree), then creates the worktree, then starts the Claw session. A worker's status is its latest turn's status. Each turn's input, output, model and effort are stored with the turn in SQLite; diffs come from git when asked. A Claw session lives for one turn, and the next turn resumes the engine's native conversation. Nobody can answer a worker's approval prompt, so each engine runs with permissions that let it commit in its worktree: Claude and agy in their auto modes, Codex with `danger-full-access` because a worktree's git data sits in the main repo's `.git` folder outside Codex's workspace sandbox, and ACP agents with Claw's default of allowing every request. `npm run check:workers` checks this live.

Claw returns a turn's output only to the request that sent it, so a turn cannot be reattached after Moxy restarts. On restart, every running turn is marked interrupted and posted to the inbox like any other ended turn, every leftover `moxy-w-` session is stopped, and sessions with no running turn are reported as orphaned. The leader's `moxy-leader` session is stopped the same way. Stopping Moxy marks running turns interrupted before Claw stops.

Worktrees follow [DESIGN.md](DESIGN.md): a sibling `<repo>-worktrees` checkout and a `moxy/` branch for every engine, preserved when changed, with no `.env` copying.

### Integration and delivery

`integrate(task, worker)` records an intent row, then waits its turn in a per-repo queue. It commits any changes left in the worker's worktree, checks that the repo's main checkout is on the worker's base branch with no uncommitted tracked changes, and merges the worker branch with `--no-ff`, or does nothing if the branch is already merged. It records the resulting revision. It refuses a dirty checkout, one on another branch or a detached HEAD, and aborts a conflicting merge so the checkout is left as it was; the leader resolves a refusal with a worker or a question. An integration still running at a restart is marked interrupted. `ready(task, revision, how_to_try)` sets the task to `waiting` with a resolved commit (repo tasks only) and, from the web step, sends a push notification. A later integration into the same repo marks earlier `waiting` revisions as superseded.

### Leader handoff

Engine, model or effort changes apply at the next turn boundary. A change, or a session that has used most of its context, starts a new native session seeded with the open tasks, their notes and the recent conversation. The same mechanism recovers from a lost native session. Quota and rate-limit failures attach provider, reset time and a suggested fallback to the failed turn, and the UI offers switch-and-retry.

### Edges

- **MCP** (loopback 18797): stateless Streamable HTTP, POST only, behind a bearer token kept in `mcp-token`. It serves the leader's tools now and external hosts' tools later, with scoped tokens. External hosts attach their workers to tasks but cannot act on other owners' workers.
- **Web API and SSE** (loopback 18798 behind Tailscale Serve): snapshot plus change events with a revision number, published after commit. The leader loop step adds the seed: `POST /api/messages` and `GET /api/conversation` behind a local bearer token kept in `web-token`, used by `moxy say`.
- **Claw** (loopback 18796): private.
- Tailscale identity checks, origin checks, the local CLI bearer and push rules follow the boundaries in [DESIGN.md](DESIGN.md).

## Leader tools

`task_create`, `task_update` (notes and plan), `task_get`, `tasks`, `delegate`, `message`, `stop`, `workers`, `result`, `models`, `quota`, `integrate`, `ready`, `reopen`, `follow_up` (set or cancel a timer), `memory_read`, `memory_update`. `delegate` needs a model and effort the engine reports, when it reports any. Completions arrive through the inbox, so there is no tool for waiting on workers.

## Layout

```text
src/
  app.ts           daemon composition and shutdown
  cli.ts
  paths.ts         data home layout
  log.ts           file log with rotation
  exec.ts          commands without a shell
  contracts/       browser-safe engine metadata, API schemas, event types
  db/              connection, single-writer lock, transactions, schema version
  moxy/            inbox, timers, memory, turn loop, leader sessions, handoff, leader tools
  tasks/           task rows and transitions
  workers/         delegate, message, stop, reconcile, output presentation
  repos/           repo resolution, worktrees, per-repo integration
  runtime/         Claw client and process, ACP and Claude leader runners
  mcp/             MCP transport and tool handlers
  web/             server, client, identity, routes, SSE, static
  providers/       model catalog, quota readers
  platform/        install, logon task, Tailscale, power, push
  testing/         fake Claw, fake ACP agent, temporary homes
web/src/
  api/             fetch client and one live-state connection
  state/           canonical collections and selectors
  features/        conversation, tasks, workers, settings
  components/ui/   shadcn primitives, unchanged
tests/             cross-layer scenarios and Playwright journeys
```

## Reference code worth copying

`exec.ts`, the Claw client and process management, git worktree helpers and parsing, the model catalog, quota readers, push, Tailscale identity, install and logon task, power and keep-awake, the ACP leader runner, the fake Claw and fake ACP agent, and the shadcn primitives. Copy only what Moxy uses, rename to Moxy's vocabulary, remove explanatory comments and keep or add attribution. Storage, the turn loop, tasks, web routes and app state are written fresh.

## Build order

Each step ends with its tests green and `format:check`, `typecheck`, `test` and `build` passing.

1. **Skeleton.** In a new worktree, remove the existing source and start Moxy-only: package name, `moxy` CLI, `~/.moxy` home, Node 24, CI, SQLite spike, schema versioning, single-writer lock, daemon lifecycle, Claw process, fakes and temporary-home harness. Ports and home are configurable for tests.
2. **Workers.** Delegate, message, stop and result through Claw with worktrees and per-turn records. Restart reconciliation tests at intent, started and finished points.
3. **Leader loop.** Inbox with batching and source-ID deduplication, turn runner for Claude and ACP leaders, leader MCP tools, user-first ordering, and interrupted-turn redelivery.
4. **Tasks and delivery.** Task rows, integrate with the per-repo lock, ready and reopen. Fake-backed journey: two tasks in one repo, a desktop edit, feedback, restart midway.
5. **Web.** Built in slices, following the reviewed mockup:
   1. Server: Tailscale identity and allowed logins, write checks, the local bearer for the CLI, a database revision bumped after each committed write, an SSE snapshot per revision, detail reads for tasks and workers, and actions to message, stop, send now, retry a failed turn, set the Orchestrator's model and effort, and message or stop a worker.
   2. Web app: React, Vite, Tailwind and shadcn with the mockup's layout, the fake-backed `web:preview`, and Playwright on desktop and mobile.
   3. Quota and model lists.
   4. Push for finished tasks.
   5. The machine switcher.
6. **Handoff and recovery.** Next-turn engine changes, context rotation, quota-failure switch-and-retry, timers and follow-ups, and user memory.
7. **Install.** Install and uninstall, logon task, Tailscale Serve on the standard ports, status, stop and restart through a local-only shutdown, keep-awake while work runs, explicit Claw upgrade command, and README.

## Open questions

- Does one leader stay responsive enough with real workloads? If not, give each task its own leader session, fed by the same inbox.
- Do external hosts need their own tasks, or do they only attach workers to Moxy's tasks?

## Credits

- The inbox, timers and memory design follows William Hu's [Building always-on agents](https://claude.com/resources/articles/building-always-on-agents) (Anthropic, 2026).
- Engine icons in `web/src/icons/` are from [Lobe Icons](https://github.com/lobehub/lobe-icons) (`@lobehub/icons-static-svg` 1.104.0, MIT).
- The web app uses [shadcn/ui](https://ui.shadcn.com) components (MIT) and [Lucide](https://lucide.dev) icons (ISC).
- Review as a parent turn or reviewer worker follows the delegation patterns of [Roo Code](https://docs.roocode.com/features/boomerang-tasks), Claude Code subagents and [OpenHands](https://www.openhands.dev/blog/20260506-the-verification-stack).
