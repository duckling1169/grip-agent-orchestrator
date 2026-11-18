# Grip — design

Grip lets you see and control the coding agents your orchestrator runs (Claude Code, Codex, Antigravity `agy`) from any device on your tailnet: iPhone, iPad, Mac, or a browser on any machine.

It does not run agents itself. [Claw Orchestrator](https://github.com/Enderfga/claw-orchestrator) does that. Grip is a thin layer around one Claw server. It gives orchestrators a small MCP tool set, gives your devices a web app behind Tailscale identity, and adds the few pieces Claw lacks: worktrees for every engine, a review handoff, quota windows, push notifications and safety limits.

Status: design, agreed in a grilling session on 2026-11-17. Chats (§5.1) were added on 2026-11-17 after the web app design pass. Build steps 1 to 9 (§17) are implemented under that original scope; steps 7 to 9 remain uncommitted. The user subsequently clarified native-app continuity as a desired capability (§5.2), explicitly not a blocker for the web UI. Other real-host integration questions remain in §18.

---

## 1. Goals

1. **See what orchestrated workers are doing, from anywhere.** For each run: engine, model, folder, worktree and branch, what it is doing now, how long it has run, its result and its diff.
2. **Control them from anywhere:** start, stop, message, view output, and stop everything.
3. **Any model can orchestrate.** Claude (Opus 5.5) orchestrates today. If GPT 7.8 is the best orchestrator tomorrow, it uses the same Grip tools. Nothing is tied to one vendor's plugin system.
4. **Show quota windows** (5-hour, weekly and the others) for every subscription, read through each provider's own documented interface.
5. **Avoid juggling.** An orchestrator delegates several jobs and then waits for whichever finishes next. It never polls each worker.
6. **The chat comes first.** You start a conversation with one model, and it hands work to the others, across vendors, to spread work and quota over your subscriptions. The app is built around that chat and the workers it manages (§5.1).
7. **No hacks.** Every integration uses an official interface: Codex app-server, agy headless mode, Claude stream-json, Tailscale identity, OS power APIs. No process-table scraping, no transcript scraping, no PTY screen-reading.
8. **Little infrastructure.** One daemon on one machine, no cloud services, no database server, no accounts.
9. **Native-app continuity.** Grip is the user's main place to start agents and orchestration, across engines. The user would like to continue Grip-started agents as the same conversations in their native apps. An idle handoff is useful; simultaneous live access is a separate capability. Verify native paths per engine (§5.2), but do not block the web UI on uniform support.

## 2. Non-goals

- **Being an agent runtime.** Claw owns engine adapters, sessions, resume and the run ledger.
- **Gists, snapshot files or any export and sync of state.** Devices read live state from the principal machine over the tailnet. If the principal is unreachable, the app says so.
- **Review or merge workflows inside Grip.** The orchestrator reviews and merges with git or `gh`, as it does today. Grip has no accept/reject states and no merge button.
- **Acceptance contracts or "decision points".** Claw's contracts apply to its workflows, not to the plain sessions Grip drives, so Grip doesn't use them.
- **Remote elevation.** Admin steps stay manual, at the machine (see §9.2).
- **Watching agents Grip didn't start.** Interactive Claude Code or Codex app sessions, and anything started outside Grip, are not shown. A Claude Code chat that uses Grip's MCP appears only through the calls it makes to Grip (§5.1).
- **Running agents on several machines at once.** There is one principal at a time, though the API stays host-aware so this remains possible later.
- **Replacing the `agent-usage` plugin.** It stays as is for local Claude Code use on the PC.

## 3. Background and findings

### 3.1 What already exists

Existing projects each cover a piece of this. Nothing meets all the constraints (Windows-native, Tailscale identity, model-agnostic, official interfaces, includes agy).

| Project | Strength | Why it isn't enough alone |
|---|---|---|
| **Claw Orchestrator** (MIT) | Claude + Codex + agy behind one runtime, official interfaces, MCP server, ledger, contracts | Loopback dashboard with a full-control token. No phone UI, no quota windows. Worktrees for Claude only |
| Codeman | Phone UI, quota display, `tailscale serve` | tmux/PTY screen-driving, WSL on Windows, no worktrees |
| `openai/codex-plugin-cc` | Clean Codex app-server jobs | Claude-only plugin, Codex-only, no worktrees, state on one machine |
| alethe-orchestrate | Quota-aware delegation | Launches workers outside any shared runtime, so they're invisible to everything else |

Decision: **adopt Claw as the runtime and build Grip around it.**

### 3.2 Claw trial on `windows-pc` (2026-11-17)

Claw 7.23.4 was installed from npm on the PC and driven through its CLI and HTTP server.

| Engine | Interface Claw uses | Result |
|---|---|---|
| Claude (`claude` 2.1.326) | stream-json | ✅ 3 s, wrote its file inside a Claude worktree (`.claude/worktrees/…`) |
| Codex (CLI 0.169.1) | app-server v2 JSON-RPC | ✅ 8 s, wrote its file |
| agy (1.5.10) | `-p --output-format stream-json` | ✅ 16 s, wrote its file |

Facts that shaped this design:

- **Workers must run in an interactive logon session.** Over key-auth SSH (a NETWORK logon), agy couldn't find its stored login and asked for OAuth again, and Codex's Windows sandbox couldn't start. Both worked when run as a scheduled task "only when user is logged on". Grip and Claw therefore run as a logon task, never as a Windows service.
- **The Codex app's bundled `codex.exe` is not a usable CLI.** The `.codex\.sandbox-bin` copy lacks its command-runner helper. The standalone CLI (`npm i -g @openai/codex`) is now installed and on PATH.
- **`-w/--worktree` only works for Claude.** Claw passes it to Claude's own `--worktree`. Codex and agy ran in the main checkout. Grip creates worktrees itself (§6.2).
- **`clawo-mcp` runs its own private session manager** and sets `CLAWO_NO_EMBEDDED_SERVER=1`, so its sessions are invisible to a separately running `clawo serve`. Only the on-disk run ledger is shared. Orchestrators therefore must not use `clawo-mcp` directly (§5).
- **Plain sessions have no event stream.** `POST /session/send` blocks until the turn ends. Server-sent events exist only for workflows, councils, autoloops and ultraapp. Live per-tool activity waits on an upstream change (§7.3).
- **Tool counts are incomplete.** The Codex and agy session status showed `Tools: 0` even though both wrote files.
- **Ledger cost figures are list-price estimates.** All engines used subscription logins, and no API key was needed.

The trial files remain in `C:\Users\you\claw-trial` (Claw source clone, `sandbox` repo, logs). Claw is still installed globally. Nothing is left running.

### 3.3 agy

agy's official [headless mode](https://antigravity.google/docs/cli/headless/) supports `-p` with `--output-format json|stream-json` and `--json-schema`. The community MCP bridges (PTY wrappers, transcript readers) worked around an old non-TTY bug (google-antigravity/antigravity-cli#318, agy 1.0.6). With current agy they aren't needed.

**Open risk:** a reply on Google's AI developer forum says wrapping `agy -p` in a local MCP server for third-party agents is not permitted. No official terms were found either way. agy is one adapter, so it can be dropped without touching the rest of Grip.

## 4. Architecture

```
 iPhone / iPad / Mac browser  ──HTTPS (tailscale serve, identity headers)──┐
                                                                            │
 ┌───────────────────────────── principal machine (windows-pc) ─────────────┼──────┐
 │  interactive logon session                                               ▼      │
 │                                                                                 │
 │  Orchestrator (Claude Code today; any MCP host later)                           │
 │      │ MCP (Streamable HTTP, loopback)                                           │
 │      ▼                                                                          │
 │  ┌──────────────────────────── grip daemon (Node, TS) ────────────────────┐    │
 │  │  MCP server      Web API + static app      Quota module   Web Push     │    │
 │  │  Run store       Worktree manager          Claw supervisor  Keep-awake │    │
 │  └───────────────┬─────────────────────────────────────────────────────────┘    │
 │                  │ HTTP, loopback, bearer token (held only by grip)              │
 │                  ▼                                                              │
 │  clawo serve (127.0.0.1:18796) ── claude (stream-json)                          │
 │                                 ── codex app-server (JSON-RPC)                  │
 │                                 ── agy -p --output-format stream-json           │
 └─────────────────────────────────────────────────────────────────────────────────┘
```

- **One process, `grip`,** listening only on `127.0.0.1`. It has:
  - an MCP endpoint for orchestrators
  - the web API and static frontend for devices
  - background jobs: supervisor, quota, push, keep-awake
- **One Claw server,** a child of `grip`, on loopback. Grip is its only client.
- **Devices** reach Grip only through `tailscale serve` (§9.1).
- **Stack:**
  - TypeScript on Node 22+ (Node 24 is on the PC)
  - Node's built-in `http`
  - `@modelcontextprotocol/sdk` (Streamable HTTP server)
  - `web-push`
  - frontend: React with Vite, Tailwind and shadcn/ui, built to static files that the daemon serves
  - no server framework, no database server

### 4.1 Principal machine

- The **principal** is the one machine that runs agents. It runs `grip` plus Claw. Today that's `windows-pc`.
- To switch, you install Grip from the [`grip-agent-orchestrator`](https://github.com/duckling1169/grip-agent-orchestrator) GitHub repo on the new machine and run `grip install`, then `grip claim`. The old principal sees it lost the role, refuses new delegations, and keeps its history browsable until you remove it.
- Repos, worktrees and run history stay on the machine where they were created. History isn't migrated.
- Viewing devices run nothing. They open the web app.
- Before the stable URL exists, the address is `https://windows-pc.<tailnet>.ts.net`. Later, a **Tailscale Service** name follows whichever machine is principal, so bookmarks survive a switch (§13).

### 4.2 Grip's own storage

Everything lives under `~/.grip/` on the principal and is never exported or synced:

- `config.json`: allowlisted Tailscale logins, protected-path additions, push settings. On first start Grip lists the Tailscale account the machine is signed in to, so the owner needs no setup.
- `chats.jsonl` and `chats/<id>/`: chat events, and each Grip chat's MCP config and turns (§5.1).
- `runs.jsonl`: an append-only log of run events (created, started, turn ended, finished, failed, stopped, viewed). Grip rebuilds run state from it on start. Claw's ledger remains the record for tokens and cost.
- `claw.json`: installed version, last-good version, update history.
- `push.json`: Web Push subscriptions and VAPID keys.
- `claw-token`: Claw's bearer token, readable only by your user.

## 5. Orchestrator interface (MCP)

Orchestrators add Grip as an MCP server (`http://127.0.0.1:<port>/mcp`) **instead of** `clawo-mcp`, `codex-plugin-cc` or the agy connector. All delegation goes through Grip, so Grip sees all of it.

| Tool | Input | Returns |
|---|---|---|
| `delegate` | `folder`, `engine` (`claude` / `codex` / `agy`), `model?`, `effort?`, `brief` (path or inline text), `retryOf?`, `chatTitle?` | Immediately: `runId`, worktree path, branch, and a quota note when that provider is low or out (information only, never a block). `chatTitle` names the calling chat in the app (§5.1) |
| `message` | `runId`, `text` | Ack. The next turn starts in the background |
| `stop` | `runId` | Ack after the worker's process tree is gone |
| `list` | `status?` (`running` / `done` / `failed`), `folder?` | Runs with title, engine, model, folder, branch, status, elapsed time, git facts, unviewed flag |
| `result` | `runId` | Brief, final result text, diff stats plus the unified diff, git facts, overlap warnings, and any messages you sent the worker yourself. Marks the run viewed |
| `wait_any` | `timeoutSec`, `runIds?` | The next run to finish or fail that hasn't been viewed yet, as `result`, or `null` on timeout |
| `quota` | — | Current windows per provider plus the `verdict()` line (added with the quota module, §8) |

Notes:

- **Delegation is asynchronous.** Claw's `/session/send` blocks, so Grip runs it in the background and tracks the run. An orchestrator's loop is: `delegate` several tasks, then repeat `wait_any`, review, and `message` or merge.
- **Briefs are written by the orchestrator** (or a subagent), not by you. Grip doesn't impose a format. If `brief` is a path, Grip checks it exists, sends the worker `Do <path>` and uses the file's first heading as the run's title. If it's inline text, the title is its first line.
- **One Claw session per turn.** Grip opens the run's Claw session for a turn and closes it when the turn ends, keeping the engine's own conversation id. A `message` reopens the session with `resumeSessionId`, so it continues the same conversation. Idle runs hold no Claw session slot and never hit Claw's idle expiry.
- **Turn length:** each turn may run up to 2 hours (Claw's own defaults are 5 to 10 minutes).
- **MCP endpoint:** `http://127.0.0.1:18797/mcp`, Streamable HTTP **with sessions**, so Grip can tell one chat from another (§5.1). `grip mcp-config` prints the command that adds it to Claude Code, and the JSON for any other MCP host.
- **The tool set is deliberately small,** not Claw's 79 tools. Councils and fan-out can become Grip tools later.

### 5.1 Chats

A **chat** is one orchestrator conversation. Every run belongs to the chat that delegated it, and the app is built around chats: each one lists the workers it manages. There are two kinds.

**Chats in Grip.** You start them from the app: pick the model that runs the chat, a folder and a first message.

- **What it is:** a Claw session that works in the folder itself, with no worktree, because the chat is the one that reviews and merges.
- **Its tools:** your own MCP servers, plus Grip's MCP through a config file that Grip writes to `~/.grip/chats/<id>/mcp.json`. That file holds a token minted for this chat, so every call it makes is tied to it.
- **Messages:** you talk to it from any device. A message sent mid-turn is delivered when the turn ends, as for workers.
- **Waiting on workers:** while its turn sits in `wait_any`, the app says it is waiting on its workers. If the chat is idle when one of its workers finishes, Grip sends it a one-line note, so it reviews without you. That costs a turn of its own quota, by design.
- **Live view:** Claw plain sessions have no event stream (§7.3), so the chat shows "working on its reply" until the turn ends, then the reply.
- **Stop:** stops its turn and every worker it manages.
- **Which models:** only Claude can host a chat today, because Claw passes `--mcp-config` to Claude sessions only. Codex and agy chats need Claw to pass an MCP config to those engines too, which is an upstream change (§10). Until then the app offers them as unavailable.

**Chats in Claude Code** (or another MCP host). These are the chats you start yourself, with Grip's MCP added.

- **Telling chats apart:** Grip treats each MCP session as one chat. If Grip restarts, a chat that reconnects shows up as a new chat. Its runs are kept and stay listed under the old one.
- **Name:** the orchestrator passes `chatTitle` on `delegate`; Grip's MCP instructions ask it to. Without one, the chat is named "Claude Code chat in `<folder>`".
- **What the app shows:** Grip can't show the conversation itself, because reading transcripts is ruled out (§1). Instead the chat view is a thread of what Grip saw: each brief, each message the chat sent a worker, each result it read, and each worker's status. You reply to the chat in its own host. You can still step in on any of its workers.

**Runs started from the app** with **Start one worker** belong to no chat and are listed apart.

**One level only.** Only chats delegate. Claude workers start with `mcp__grip` in their denied tools, so a worker that loaded Grip from your user config can't call it. Codex and agy workers don't get Grip, as long as Grip is added only to the orchestrator's host (§15).

**Messages to workers.** When you message a worker directly, its chat sees that message the next time it reads the run, through `result` or `wait_any`.

**Storage:** `chats.jsonl` holds chat events (created, named, turn started or ended, stopped), and each run event carries its `chatId`. A Grip chat's turns are stored like run turns.

### 5.2 Native-app continuity — desired enhancement, not a release blocker

The user intends to use Grip for all their agents and orchestration and would like to continue agents in their respective native apps. They explicitly clarified that this is not strictly a blocker. An idle handoff (start Claude agent A in Grip, then continue the same saved conversation in Claude Desktop after Claw releases it) is a valid useful path. This applies to Grip-started workers as well as parent chats; it does not by itself require monitoring arbitrary sessions started outside Grip. Exact native app surfaces can be confirmed when implementing each adapter.

The current Claw-backed path saves native conversation IDs after turns; it has no native-app handoff action yet. Keep the native ID, workspace/worktree, and user/profile identity, and verify that opening the native app continues that exact saved conversation. An idle handoff, visibility during a running turn, and synchronized control are separate capabilities; do not conflate them. Control must be coordinated so Grip and the native app do not independently submit turns to the same conversation. Also verify that a native continuation preserves the MCP configuration and chat/worker role constraints it needs. Native messages are not automatically reflected in Grip's own event log merely because the engine's saved history is shared.

Initial official-documentation findings (2026-11-17; not real-host test results):

- **Codex:** [`/app` opens the same saved CLI chat in the desktop app](https://learn.chatgpt.com/docs/developer-commands#continue-in-the-desktop-app-with-app). Claw uses `codex app-server` rather than the interactive CLI. The [app-server API](https://learn.chatgpt.com/docs/app-server) supports stored thread IDs/read/resume, but `thread/list` defaults to interactive sources (`cli`, `vscode`), excluding `appServer` unless explicitly included. Automatic desktop discovery and live viewing of Claw-created threads remain unverified. The [changelog](https://learn.chatgpt.com/docs/changelog) also documents read-only behavior when a conversation is open in another app; do not assume simultaneous control.
- **Claude:** [Desktop can resume saved CLI conversations](https://code.claude.com/docs/en/desktop#coming-from-the-cli), but refuses takeover of an active CLI/background session. The [VS Code extension explicitly supports saved print-mode/SDK sessions](https://code.claude.com/docs/en/vs-code#resume-past-conversations). [Remote Control](https://code.claude.com/docs/en/remote-control) provides a separate live connection mode; this is not evidence that an arbitrary Claw `claude -p` session is attached to it. Native discovery, supported handoff, and persistence of per-chat MCP configuration must be tested with the selected app.
- **Antigravity:** [Headless mode](https://antigravity.google/docs/cli/headless/) exposes a conversation ID and CLI resume. The documented [App-to-CLI import](https://antigravity.google/docs/cli/commands/resume/) clones a conversation. [Remote agents](https://antigravity.google/docs/remote-agents) have cross-surface continuity, but that is a different execution model from Grip's local headless workers. A supported local headless-to-native-app path remains unverified.

Follow-up enhancement: verify these paths against the installed native apps using official interfaces, starting with Claude's documented idle handoff (`claude --desktop --resume <session-id>`). Add native-open/handoff actions per engine where verified, identifying any needed Claw adapter changes or upstream support. Keep capability explicit per engine; do not promise uniform live support before checks pass. Continue the web UI in parallel; native interoperability is not a gate. Do not use private app databases, transcript scraping, or UI automation as a substitute for a supported integration.

## 6. Runs

### 6.1 Lifecycle

`running` → `done` | `failed` | `stopped`, taken from Claw's session and turn status. A message on a finished run sets it back to `running`. Runs also have one flag, **viewed**, which is cleared when the run finishes and set when `result` is called or the run is opened in the app.

### 6.2 Folders and worktrees

- **Any folder works** (§9.2 sets the limits). Grip resolves real paths before using them.
- **If the folder is a git repo,** Grip creates a worktree before starting the session, for every engine:
  - folder: `<repo>-worktrees\<engine>-<slug>`, a **sibling** of the repo and never inside it, which keeps the `-codex-` / `-agy-` / `-claude-` naming
  - branch: `grip/<engine>-<slug>`
  - then Grip starts the Claw session with `cwd` set to the worktree, and doesn't use Claw's `-w` option
- **If the folder is not a repo,** the worker runs there directly. Example: "fix my network settings" runs in your home folder.
- **Nothing is copied into worktrees.** No `.env` handling. A worker that needs local config creates it.
- **Cleanup is manual.** The app lists finished runs' worktrees with their age and disk size, with a Remove button. Nothing is deleted automatically.
- **Overlap warning:** if another active run in the same repo has changed any of the same files, the run detail says so. Grip doesn't prevent it.

### 6.3 Orphans and retries

- **Runs belong to Grip, not to the chat that started them.** If an orchestrator's chat closes, its workers keep running, and their results, briefs and diffs are kept. A new orchestrator chat, of any model, picks up the oversight with `list` and `wait_any`. The app shows finished, unviewed runs either way.
- **A stopped or failed worker can only be continued by the same engine,** through Claw's session resume. Another engine can't inherit its context.
- **Retry with another engine** (`delegate` with `retryOf`, or the **Retry with…** button) starts a fresh run from the same brief in a new worktree.

### 6.4 Interrupted runs

If the principal sleeps, reboots or Claw crashes, Grip marks the affected runs `failed: host slept/restarted` (or `claw restarted`) on its next start, so nothing stays stuck as running. Codex threads can be resumed through Claw.

## 7. What it shows

### 7.1 Per run

- **Identity:** title (from the brief), engine icon, model, effort, folder, worktree, branch.
- **Status in plain words,** using the wording helpers from `agent-usage` (§11): "turn 3 · 4 min", "done 12 min ago", "failed: …".
- **Runtime:** started, elapsed, turn count, tokens, from Claw session status and the ledger.
- **Git facts** from the worktree: files changed, last edit and which file, commits ahead of the base branch, last commit message.
- **Output:** the brief, each turn's result text, the session history (via `/session/grep`), and the diff, per-file and collapsible.
- **Overlap warning** (§6.2).

### 7.2 Global

- The principal's name, whether it's online, the Claw version (and any rolled-back update).
- **Quota strip:** one bar per provider for its tightest window, with reset times and the `verdict()` line ("Codex is running low (18% left)").
- Worktree disk use.

### 7.3 Current activity

- **Until Claw changes:** activity is turn-level (turn N running for M minutes) plus git facts (files changing, last edit). That is everything Claw's HTTP API exposes for plain sessions today.
- **Later:** an upstream PR to Claw adds per-session SSE (`/session/<name>/events`), modelled on its workflow events. Claw's engine adapters already parse each engine's tool events internally. When that ships, the activity line becomes live tool-by-tool events and nothing else changes.
- **Ruled out:** parsing engine transcript files or watching process trees.

## 8. Quota windows

Grip has its own TypeScript quota module. The parsers are ported from alethe-orchestrate's `orchestrate.py` (MIT; credit in the source). Grip doesn't call alethe or Python. Each provider is read through its own documented interface:

| Provider | Source | Windows | Cost to read |
|---|---|---|---|
| Codex | app-server `account/rateLimits/read` RPC, plus the `account/rateLimits/updated` notification (confirmed in the 0.169.1 schema) | `primary`/`secondary` by `window_minutes` (300 → 5h, 10080 → week) | None, it's an account read. `pingCodex` goes away |
| agy | `agy -p /usage --output-format json` (built-in command through official headless mode) | `groups[].buckets[]`: `remaining_fraction`, `reset_time` (5h, week, argon, 3p windows) | Negligible |
| Claude | `rate_limit_event` in stream-json / Agent SDK output: `rate_limit_info.unifiedWindows.{five_hour, seven_day, seven_day_opus}` (`utilization`, `resetsAt`) | 5h, week, opus | None when read from worker turns. Otherwise a small on-demand probe |

**Not used:** private usage endpoints, OAuth tokens read from credential files, or Codex rollout-file tailing.

**Refresh triggers:**
- Codex's `rateLimits/updated` notification
- after any worker turn
- the refresh button in the app
- a timer that reads every provider, every 5 minutes by default (`settings.quotaRefreshMinutes` in `~/.grip/config.json`, 0 for off)

The timer includes Claude's probe, a one-line Haiku turn each time. The user chose this (November 18, 2026): current Claude quota on the phone is worth the small cost.

The output type stays `ProviderUsage` / `UsageWindow` from `agent-usage/types`, so the wording helpers work unchanged.

## 9. Security

### 9.1 Who can reach Grip

1. **Network:** a Tailscale ACL grant lets only your user's devices reach the principal's Grip port. Grip is never exposed on the LAN and never through Funnel.
2. **Identity:** Grip listens on `127.0.0.1` only. `tailscale serve` terminates HTTPS and adds `Tailscale-User-Login`. Grip accepts a request only if that login is in `config.json` (today `duckling1169@`). A request without the header, meaning a local process calling the loopback port directly, is refused for everything except `GET /health` and the MCP endpoint, whose own guard is described below. Identity is never taken from anything the browser sends.
3. **MCP endpoint:** loopback only and never published through `tailscale serve`. A per-install token is passed in the orchestrator's MCP config, so arbitrary local processes can't use it.
4. **Claw:** loopback only. Its full-control token lives only in Grip's process memory and `~/.grip/claw-token`. The browser never sees it, and Grip never offers a pass-through to Claw's API.
5. **To verify during the build:** whether a Tailscale Service host must be tagged, and whether identity headers still arrive through a Service. Fallback: resolve the caller with `tailscale whois` through Tailscale's local API.

No passwords, no login screen, no tokens on your phone.

### 9.2 What workers may do

Workers may do **anything your user account can do**, with three hard limits:

1. **Never elevated.** Grip and Claw run as your normal user. Admin actions (network adapters, firewall, services) are **manual**. A worker that needs one writes the exact script. Grip sends "Admin action requested" to your phone with the full script, and the step runs only at the machine through the normal UAC prompt. This is the same model as Claude Code and the Codex app. There is no elevated runner.
2. **Protected paths.** Workers can't write to Tailscale's config, `~/.grip`, Claw's install and state, `~/.ssh`, or credential stores (`~/.claude` and `~/.codex` auth files, `~/.gemini`, Windows Credential Manager). This is enforced through each engine's own permission and sandbox settings, passed by Claw, plus Grip refusing these as `delegate` folders. It prevents an agent from cutting your remote access, taking over its own supervisor, or leaking logins.
3. **Stop all works.** The app's **Stop all** marks every run stopped, then gives Claw 5 seconds to stop each session. If Claw doesn't, Grip restarts Claw with its whole process tree, which kills every worker. Grip never looks for worker processes itself.

**Per-engine permission defaults** for unattended workers:
- Claude: `acceptEdits` plus auto mode
- Codex: `workspace-write` sandbox
- agy: its explicit permission mode

These are set once in Grip's code, not per run.

### 9.3 Accepted risks

- **Exfiltration.** Workers have network access. A worker that reads hostile content (a web page, an issue) could be tricked into sending code out. Protected paths cover credentials but not your code. An egress policy would be heavy infrastructure, so it's left out.
- **Principal unreachable.** If Tailscale on the principal logs out or breaks, Grip and its workers can't be reached from any device. Workers keep running. This is known and accepted behavior. SSH over the tailnet stays as an emergency path, and Grip never modifies SSH or Tailscale config.
- **agy terms** (§3.3).
- **Claw's pace of change** (§10).

## 10. Claw supervisor

- **Install range `>=7.23.4 <8`.** Every 7.x release is taken automatically. A new major waits for you to approve it.
- **Daily npm check.** Updates install only when **no run is active**.
- **Health gate after each update:** restart Claw, check that the API answers, check that the response fields Grip reads are still there, and start and stop a no-op session on each engine (no prompts, so no quota spent).
- **Rollback:** if the gate fails, Grip reinstalls the last version that passed and the app shows a banner ("Claw 7.24.0 failed checks, staying on 7.23.4"), plus a push.
- **Restart on crash** with backoff. Runs interrupted by a crash are marked as in §6.4.
- **Upstream contributions** Grip would benefit from:
  1. per-session SSE events (§7.3)
  2. `clawo-mcp` able to attach to an existing server
  3. `-w` for Codex and agy
  4. tool counts for Codex and agy
  5. an MCP config for Codex and agy sessions, so they can host chats (§5.1)

## 11. Reuse from `agent-usage`

The plugin stays unchanged; it's still useful for local Claude Code on the PC. Grip **copies** what it needs into its own source with a comment naming the origin (`duckling1169/agent-usage`, `hooks/lib/logic.ts`), so the two can change independently.

| Copied | Purpose in Grip |
|---|---|
| `types`: `ToolId`, `UsageWindow`, `ProviderUsage`, `Worktree` | Quota and git fact shapes |
| `TOOL_NAMES`, `WINDOW_LABELS` | Labels |
| `verdict`, `windowLevel`, `Tone` | Quota strip and the low-quota note in `delegate` |
| `minutesBetween`, `agoText`, `untilText`, `durationText` | All time wording |
| `parseWorktreeList`, `parseStatusFiles`, `basename` | Worktree listing and changed files |
| The worktree half of `probe.ts` `readWorktree` (git commands only) | Git facts per run |
| `describe` / `workSummary` wording | Status line and list summary, adapted to runs |
| `theme.ts` palettes | A starting point for the design pass |

**Not copied:**
- `findAgents`, `activityOf`, `workerKind`, `folderNamedIn`, `listProcesses`: process scraping, replaced by Claw sessions.
- `locateUsageScript`, `readUsage`, `parseUsage`, `pingCodex`: alethe-based, replaced by §8.
- The `$` engine wrapper: Grip uses Node's `child_process` and `fs`.

## 12. Web app (functional requirements)

The agreed screens are in the design canvas (claude.ai artifact `JktKuQYLVZ7S8FvLmixduy`, "Grip, chats first"). This section fixes what the app must show and do.

- **Components:** React with Tailwind and shadcn/ui (chosen November 18, 2026), so the app follows one maintained standard instead of custom styling. The agent colours are the only custom colours.
- **Header:** the Grip mark once, a **machine switcher** and a **settings menu** (worktrees, Claw updates, settings, Stop all). Nothing else.
- **Machine switcher:** lists tailnet machines from `tailscale status`, marks this one, and asks each online computer whether Grip answers on its `/health`. Choosing another machine shows that machine's Grip in the same app: the page stays on the machine it was installed from, and API calls and the event stream go to the chosen machine's address. The choice is remembered on the device. Each Grip stays independent and checks the caller's Tailscale identity itself; one Grip never forwards to or starts another. A Grip answers CORS requests only from `https://<one label>.<this tailnet>.ts.net` origins, read from Tailscale at start. Each machine needs its own `grip serve` and `tailscale serve`. The service worker caches the app shell (never API data), so the app still opens when the machine that served it is off.
- **Sections:** Needs you (only when something does), Chats and Independent workers are collapsible with a count. Quota is a footer that always shows each agent's 5-hour and weekly windows, with no summary sentence.
- **An installable web app** (Add to Home Screen) served by Grip. It must work well on a phone in portrait and on landscape screens (iPad, desktop).
- **Layout:**
  - landscape: a sidebar of chats, each with its workers indented under it, and the selected chat as the main view
  - phone: the chat list, then a full-screen chat, then a full-screen worker
- **Telling agents apart:** each engine has one mark and colour, used for chats, workers and quota alike: Claude ✻ terracotta, Codex ◆ green, Antigravity ▲ blue (from `agent-usage`'s theme). A working run has a slow pulsing dot in its engine's colour. Yellow is kept for the *Needs you* block alone.
- **Views and actions:**
  - **Needs you** at the top: a stopped or failed worker, or an admin request, with **Continue** and **Retry with another agent**. It names the chat waiting on it.
  - **Chat list:** chats with their workers nested, then runs that belong to no chat. Unviewed runs are marked.
  - **A Grip chat:** the conversation, with each hand-off shown inline as a card for that worker and its live status, plus a message box. Action: **Stop this chat**, which also stops its workers.
  - **A Claude Code chat:** the thread of briefs, messages and results Grip saw (§5.1), the *Needs you* block for its workers, and a note that you reply to it in its own host.
  - **Worker detail:** everything in §7.1, plus the chat it works for. Actions: **Message** (its chat sees it too), **Stop**, **Retry with another agent**, **Copy the folder path**.
  - **Start a chat:** the model that runs it, with each one's quota left, a folder (typed, recent, or browsed), model and effort from each agent's own list. No first message: you write it in the chat.
  - **Delete a chat:** swipe, long-press or right-click, then a small confirm. It stops anything still working and hides the chat and its workers; files stay on disk.
  - **Start one worker:** folder, engine, model and effort, brief (text or path). The same call as `delegate`, for work that needs no chat.
  - **Global:** quota, **Stop all runs**, worktree cleanup list, Claw status and update history, notification settings.
- **Live updates:** Grip serves its own SSE stream of run and quota changes to the app. The app never polls Claw.
- **Light and dark themes** following the system.

**Web API** (`127.0.0.1:18798`, behind `tailscale serve`, identity-checked). Writes must be JSON, and any `Origin` must be Grip's own, because `tailscale serve` adds your identity to requests from every page in your browser:
- `GET /api/state` (chats, runs, quota, Claw)
- `GET /api/models`, `GET /api/folders?path=`, `GET /api/machines`
- `DELETE /api/chats/:id`
- `GET /api/chats/:id`
- `POST /api/chats` (start a Grip chat)
- `POST /api/chats/:id/message`
- `POST /api/chats/:id/stop`
- `GET /api/runs/:id`
- `POST /api/runs` (delegate)
- `POST /api/runs/:id/message`
- `POST /api/runs/:id/stop`
- `POST /api/runs/:id/retry`
- `POST /api/stop-all`
- `GET /api/events` (SSE)
- `GET` / `DELETE /api/worktrees`
- `POST /api/quota/refresh`
- `POST /api/push/subscribe`

## 13. Notifications

- **Standard Web Push** to the installed web app (iOS and iPadOS home-screen apps; browsers on the Mac). Uses VAPID keys and Apple's and the browsers' own push services. No third-party account, nothing to host.
- **Payloads are titles only,** for example "Codex · fix-login done". Never code or output.
- **Events:**
  - a run finished
  - a run failed
  - an admin action requested
  - a Claw update rolled back
  - the principal going offline (sleep or shutdown)

  Each can be muted. There are no per-turn or progress pushes.

## 14. Keep-awake

While at least one run is active, Grip keeps the principal from sleeping. It releases the hold when the last run ends, so normal sleep settings apply when idle, and the display can still sleep.

- **Windows:** `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`. Node can't call Win32 itself, so a small PowerShell helper makes the call and then waits on stdin. The hold ends when the helper exits, including when Grip dies.
- **macOS:** an `IOPMAssertion` that prevents idle system sleep (the same thing `caffeinate -i` uses).

Wake-on-LAN is not planned. A sleeping principal shows as offline.

## 15. Install

- **Grip:** `npm i -g` from the [`grip-agent-orchestrator`](https://github.com/duckling1169/grip-agent-orchestrator) GitHub repo. It provides a `grip` CLI:
  - `grip install`, which:
    - installs Claw within its range and the Codex CLI if it's missing
    - registers Grip as a **logon task** (Windows, "only when user is logged on") or a **LaunchAgent** (macOS), never a service
    - configures `tailscale serve`
    - generates VAPID keys and the MCP token
    - prints the MCP config snippet for orchestrators
  - `grip claim`: make this machine the principal
  - `grip status`: Grip, Claw and Tailscale health, plus the active runs
  - `grip stop-all`: the same as the app button, from a shell
- **Orchestrator setup:** add Grip's MCP server to the orchestrator's host only (Claude Code), never to Codex's or agy's own config, so workers of those engines don't get it (§5.1). Remove `clawo-mcp`, `codex-plugin-cc` delegation and the agy connector from the orchestrator's config. Turn off alethe's auto-delegation.

## 16. Testing

- **The test suite never calls real models.** A Claw `custom` engine preset runs a fake CLI that emits Claude-style stream-json (tool events, results, a `rate_limit_event`). It's used for `delegate` → `wait_any`, stop, message, retry and the update health gate.
- **Unit tests** for the copied `logic.ts` pieces (bring over the existing `logic.test.ts` cases), the quota parsers (fixtures from real Codex RPC, agy `/usage` and Claude `rate_limit_event` payloads), worktree naming and protected-path checks.
- **Auth tests:** missing header, wrong login, loopback without a header, MCP without its token.
- **A manual smoke test** on the PC, run as a logon task: one tiny task per real engine, the same as the trial in §3.2.

## 17. Build order

1. This write-up and the `grip-agent-orchestrator` repo.
2. Claw supervisor: start, keep alive, auto-update within range, health gate, rollback.
3. Run store and worktree manager.
4. Orchestrator MCP: `delegate`, `message`, `stop`, `list`, `result`, `wait_any`, `quota`.
5. Quota module (§8).
6. Web API and SSE with Tailscale identity. Hard limits, Stop all, keep-awake (Windows).
7. Design pass (done: chats first).
8. Chats (§5.1): chat store, MCP sessions tied to chats, `chatTitle`, Grip-hosted Claude chats with their own MCP config, idle-chat notes, `mcp__grip` denied to Claude workers, your worker messages in `result`.
9. The web app (§12), built to the agreed screens. Native-app handoff (§5.2) can be added incrementally and does not block this step.
10. Web Push.
11. `grip install` on Windows. Switch the orchestrator over from `codex-plugin-cc`, the agy connector and alethe delegation.

**After that,** roughly in this order:
1. The upstream Claw PR for session events, then live activity.
2. The Tailscale Service name for a stable URL.
3. macOS `grip install` and `grip claim` (full principal switching), plus macOS keep-awake.
4. Dev-server preview links on runs.
5. The admin-request flow (§9.2).
6. Councils and fan-out as Grip tools.
7. Claude channels push into the orchestrator session.

## 18. Open questions to verify during the build

- Tailscale Service hosts: is tagging required, and do identity headers arrive through a Service?
- ~~Does Claw expose Claude's `rate_limit_event`?~~ No. Claw 7.23.4 reads it only to rotate accounts and keeps just the highest utilization. Grip reads Claude with its own probe (a one-line Haiku turn) on the quota timer and when asked, never after turns.
- Can Claw's per-engine permission settings enforce the protected paths for all three engines, or does Grip need an extra guard for some engines?
- ~~Can Grip issue `account/rateLimits/read` on Claw's Codex connection?~~ Grip keeps its own short-lived app-server client (initialize, read, exit). `account/rateLimits/updated` arrives only on the connection running a turn, which is Claw's, so Grip reads again after each Codex turn instead.
- The status of Google's terms on third-party orchestration of `agy -p`.
- Does the Claude Code desktop app open one MCP session per conversation, so each chat gets its own session (§5.1)? If not, Grip needs another way to tell its chats apart.
- Does a `mcp__grip` deny rule in a Claude worker's settings block every Grip tool, including ones loaded from your user config?
- Can a Grip chat's turn wait in `wait_any` for long stretches inside the 2-hour turn limit, or should `wait_any` return sooner so the chat ends its turn and Grip wakes it with a note?
