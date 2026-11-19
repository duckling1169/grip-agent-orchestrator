# Moxy implementation plan

[DESIGN.md](DESIGN.md) owns product behavior. This document owns how Moxy is built. Moxy is built from the ground up in a git worktree. The existing code is reference material only: copy a module when it already does the job well, rename it to fit, and delete everything else.

## Principles

- One daemon, one SQLite file, one leader conversation. No second runtime, broker, workflow engine or agent framework.
- Claw runs workers. Moxy adds tasks, worktrees, integration, device access and quota. Do not rebuild Claw's execution kernel.
- Review is a leader turn, not a stored lifecycle. The leader reads results and runs checks; heavier review is another worker with a review prompt.
- Only the user closes a task. Acceptance must come from a turn that a user message started.
- Record intent before every external call (Claw, Git), and reconcile after a restart. Never promise exactly-once; never launch a duplicate silently.
- No legacy code, deprecated paths, compatibility shims, aliases or migrations from earlier versions. Moxy has no history to stay compatible with.
- Name things well and keep code DRY. Add an abstraction only when two real callers need it.
- No explanatory code comments. Names, types and small functions explain the code. Always credit the source of copied or adapted code, ideas and designs.

## Decisions

- **Runtime:** Node 24 LTS; `engines` and CI move together. One package, one daemon.
- **Storage:** SQLite through `node:sqlite`, one writer, short transactions. Large outputs and diffs stay on disk, referenced from rows; write the file before committing the reference. Config and secrets stay files. Day-one spike: transactions, restart and Windows packaging. If `node:sqlite` fails the spike, use `better-sqlite3`.
- **Claw:** depend on the `>=7.23.4 <8` range, with startup compatibility checks and crash restart. No automatic updates; upgrading is an explicit command.
- **Leaders:** Claude leaders run through Claw; other leaders run through ACP directly so they receive session-scoped MCP tools. Keep the Codex ACP adapter.
- **Web:** `node:http`, SSE and the existing React/Vite/Tailwind/shadcn stack. Shared Zod schemas live in a browser-safe `contracts/` folder. Add Hono, TanStack Query or a router only for a demonstrated need.
- **Tests:** Vitest with the fake Claw and fake ACP agent; a few Playwright journeys against the fake preview. Automated tests never call real models.
- **Not adopted:** XState, LangGraph, an ORM, a DI framework, a plugin loader, generic base classes.

## How it works

### The turn loop

Everything the leader reacts to goes into a durable **inbox**: user messages, worker finished/failed, quota errors and integration results. The daemon runs one leader turn at a time and always takes user messages first. An item is marked done when its turn completes. After a crash, an item whose turn was interrupted is delivered again, with a note that the earlier turn was cut off.

Long work never runs inside a leader turn. The leader delegates, then the turn ends. A worker's completion arrives later as a new inbox item. This keeps the conversation responsive without per-task leader sessions.

### Tasks

A task is a row: repo, title, plan and decisions, testing notes, and status `working`, `waiting` (on the user, with the delivered revision and how to try it) or `done`. Feedback on a `waiting` or `done` task sets it back to `working`. Workers belong to a task, or stand alone when the user starts one directly.

The leader keeps task detail out of its own context. It reads and writes task notes through tools, so a fresh native session can be rebuilt from the task rows and recent messages.

### Workers

`delegate` writes a worker row first (engine, model, effort, task, worktree path), then creates the worktree, then starts the Claw session and records its name. Each turn's input, output, model and effort are stored per turn. On restart, the daemon lists Claw sessions and reconciles every worker that was running: it reattaches, marks it interrupted, or reports it as orphaned.

Worktrees follow [DESIGN.md](DESIGN.md): a sibling `<repo>-worktrees` checkout and a `moxy/` branch for every engine, preserved when changed, with no `.env` copying.

### Integration and delivery

`integrate(task, worker)` takes a per-repo lock, checks that the target checkout is clean and on the expected base, merges the worker branch, records the resulting revision and releases the lock. It refuses a dirty or moved target, and the leader resolves it with a worker or a question. `ready(task, revision, how_to_try)` sets the task to `waiting` and sends a push notification. A later integration into the same repo marks earlier `waiting` revisions as superseded.

### Leader handoff

Engine, model or effort changes apply at the next turn boundary. A change, or a session that has used most of its context, starts a new native session seeded with the open tasks, their notes and the recent conversation. The same mechanism recovers from a lost native session. Quota and rate-limit failures attach provider, reset time and a suggested fallback to the failed turn, and the UI offers switch-and-retry.

### Edges

- **MCP** (loopback 18797): the leader's tools and external hosts' tools, with scoped tokens. External hosts attach their workers to tasks but cannot act on other owners' workers.
- **Web API and SSE** (loopback 18798 behind Tailscale Serve): snapshot plus change events with a revision number, published after commit.
- **Claw** (loopback 18796): private.
- Tailscale identity checks, origin checks, the local CLI bearer and push rules follow the boundaries in [DESIGN.md](DESIGN.md).

## Leader tools

`task_create`, `task_update` (notes and plan), `task_get`, `tasks`, `delegate`, `message`, `stop`, `result`, `models`, `quota`, `integrate`, `ready`, `accept`, `reopen`. `accept` is refused unless the current turn started from a user message. Completions arrive through the inbox, so there is no tool for waiting on workers.

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
  moxy/            inbox, turn loop, leader sessions, handoff, leader tools
  tasks/           task rows and transitions
  workers/         delegate, message, stop, reconcile, output presentation
  repos/           repo resolution, worktrees, per-repo integration
  runtime/         Claw client and process, ACP and Claude leader runners
  mcp/             MCP transport and tool handlers
  web/             server, identity, routes, SSE, static
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
3. **Leader loop.** Inbox, turn runner for Claude and ACP leaders, leader MCP tools, user-first ordering, and interrupted-turn redelivery.
4. **Tasks and delivery.** Task rows, integrate with the per-repo lock, ready, accept and reopen, and push. Fake-backed journey: two tasks in one repo, a desktop edit, feedback, restart midway.
5. **Web.** API, SSE snapshot and changes, conversation-first UI, task sidebar, worker inspector, quota. Playwright on desktop and mobile.
6. **Handoff and recovery.** Next-turn engine changes, context rotation, quota-failure switch-and-retry.
7. **Install.** Install and uninstall, logon task, Tailscale Serve on the standard ports, explicit Claw upgrade command, and README.

## Open questions

- Does one leader stay responsive enough with real workloads? If not, give each task its own leader session, fed by the same inbox.
- Do external hosts need their own tasks, or do they only attach workers to Moxy's tasks?
