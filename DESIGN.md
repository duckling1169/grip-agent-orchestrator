# Moxy design

Moxy is one persistent conversation that coordinates coding workers across repositories and providers, accessible from any device on your tailnet. Any supported model can lead or work. Moxy delegates, reviews results, and brings questions and decisions back to you.

This document owns product behavior. [IMPLEMENTATION.md](IMPLEMENTATION.md) owns architecture, library choices and build order.

## Working loop

- One Moxy conversation coordinates resumable tasks. Each task keeps its repo, agreed plan, decisions, feedback, rejected approaches and testing conventions; the conversation does not need every task's full history in one model context.
- Moxy has broad implementation freedom within the agreed plan: delegate, retry, change models or work directly, considering context and quota. Make reasonable reversible choices; ask when interpretations would produce substantially different work or the product direction needs to change. Notify the user when progress requires their input.
- Workers implement; Moxy owns technical review, checks, local commits and integration, and verification of the combined result. Independent worker success is not enough when tasks affect the same repo. Pushing and deployment permissions remain separate decisions.
- Deliver through each repo's established testing workflow, such as refreshing the airport simulator's usual URL. Explain what is ready and how to try it. For nonvisual fixes, summarize the reproduced failure, verification and remaining limitations. Dedicated preview infrastructure is optional.
- The user judges intent, behavior and look and feel rather than reviewing every code change. Ready for feedback follows technical review; user acceptance closes the task. Negative feedback automatically continues the same task, with clarification when useful.
- Implementation and long checks run as workers outside the conversational turn, so other tasks, worker completions and user messages remain responsive. Waiting for user feedback requires no active worker.

## Product behavior

1. **Conversation and tasks.** One machine-wide Moxy conversation backed by resumable tasks, defaulting to the home or configured workspace. Resolve repos from active tasks, recent folders and a lightweight workspace index, without manual tags. External hosts attach their workers to the shared task list while keeping ownership boundaries.
2. **Review and delivery.** Workers belong to tasks. Review is Moxy's own turn after a worker finishes (reading the result and running checks), or another worker given a review prompt; it is not a stored worker lifecycle. A task is `working` until Moxy has reviewed and verified it, then `done` with the delivered revision and how to try it; Moxy tells the user in the conversation and by notification. Feedback on finished work reopens it automatically. Questions, approvals and results belong in the conversation.
3. **Engine handoff.** Engine, model and effort changes apply at the next turn boundary. The new native session starts from the task records and recent conversation, preserving decisions, feedback and testing conventions. Exhaustion, rate-limit errors or known 0% quota attach provider, reset time and a suggested fallback to the failed turn, producing an inline switch-and-retry action; no proactive low-quota warnings. Moxy may choose recovery models within the agreed task; the switch action also supports user-directed recovery.
4. **Conversation-first UI.** Desktop has three columns. The sidebar groups tasks under Working (a worker runs), Reviewing (Moxy reviews, integrates or verifies the finished work) and Done, plus Orphans for workers without a task, one line each: the model family icon and the title. A ring spins round the icon while a task is Working or Reviewing, and round an orphan's icon while it runs; a failed worker gets a red outline and a stopped or interrupted one a grey outline, and status never recolours the icon. Quota sits under the sidebar. The Moxy stream is in the middle: user messages in a filled bubble, Moxy's replies as plain text with the icon, model, effort, time and a copy action shown on hover. The composer is a bare box; its send button becomes Stop while Moxy works and the box is empty, and beside it the Orchestrator's engine, model and effort apply from the next turn. A message waiting for the next turn says Queued with Send now, which stops the current turn and starts a new one with everything waiting. A failed turn puts a red mark beside its message; clicking it retries. The click-open inspector shows a task (how to try it, plan, notes, testing, workers, integrations) or a worker (turns, changes, stop, message). Each worker shows its engine, model, effort, start time and changed files, and while it runs, how long its turn has run and its latest step. Both side columns resize within limits and hide, and the sidebar can sit on either side. Mobile has Moxy, Tasks, Quota and Settings tabs, with task and worker pages behind Tasks. A machine switcher in the header opens Moxy on another tailnet machine. Connection trouble shows only as a dot beside the machine name; offline, live values become dashes and controls are disabled. Model family icons are [Lobe Icons](https://github.com/lobehub/lobe-icons) (MIT).
5. **Workers and worktrees.** Each git worker gets a sibling `<repo>-worktrees` checkout and a `moxy/` branch, regardless of engine. Non-repo workers use the requested folder directly. No local config or `.env` files are copied. Continue resumes the same engine's native conversation; Retry starts a fresh worker and worktree, including on the same engine. Preserve changed worktrees; support explicit cleanup and removal of unchanged ones. Overlap warnings include unmerged finished work.

## Truthful details

- Show next-turn settings while a worker runs and offer Stop and continue; do not imply mid-turn message injection. Label selectors Next-turn model and wall time Time since started.
- Record model and effort per turn.
- Inspector: explicit refresh, last-fetched time and bounded refresh while running.
- A worker's latest step comes from its Claw session history: the newest Claude tool call or Codex item. ACP engines and agy record only results there, so they show changed files and no step.
- Machine switcher: distinguish tailnet connectivity from detected Moxy availability, show discovery errors and check time, and keep last-loaded links available when refresh fails. Switching opens the other machine's own page without forwarding credentials or task selection.
- Quota: a table with shared family, last-checked and remaining 5h/7d headers, and provider-specific recheck controls. Usage tooltips show reset times, observations and staleness; unavailable providers have red family names with error tooltips, and Claude's check cost is stated.
- Show clipped output, skipped-file reasons, binary or no-text patches and git collection failures distinctly from a clean tree.
- Report notification test sent and device counts and errors accurately. Label partial worktree and history views and offer Show all.

## Boundaries

- Bind services to loopback. Publish only the device web app and API through Tailscale Serve, never LAN or Funnel access, MCP or Claw. Allow only configured Tailscale identities (apart from the public health check); check JSON writes and trusted origins.
- The local CLI bearer applies only without a Tailscale identity; shutdown stays local-only. Keep Claw's token private and MCP credentials scoped. External hosts must not impersonate the Moxy leader or cross worker ownership boundaries.
- Workers do not receive delegation tools. The leader delegates visible work through Moxy; native subagents and background jobs must not silently outlive their turn.
- Never elevate or provide remote admin execution. Resolve real paths and refuse protected working directories. Per-engine enforcement of protected paths and Claude's denial of all Moxy tools need live verification.
- Stop all records stopped work before waiting for sessions to exit; a bounded restart kills Claw's process tree if sessions will not stop. Keep output and history.
- Worker network access remains available; repository data is not protected by an egress policy. Loss of tailnet connectivity leaves workers running.
- Claude quota reads spend one small Haiku turn. The default five-minute timer includes Claude; setting `quotaRefreshMinutes` to 0 disables it. Post-turn refresh reads Codex and agy, never probes Claude. Show refresh costs, stale readings and errors.
- Push payloads contain titles only, never code or output, and go only to devices owned by still-allowed logins. Keep offline notification handling bounded; deliberate stops and startup recovery do not send completion or failure spam.
- Install must preserve existing Tailscale mappings. Uninstall preserves data, Claw and Serve configuration. Installation uses a normal-user Windows logon task; keep-awake lasts while work is active.

## Acceptance

- Conversation, task context and delivery state survive restart; feedback continues the task automatically; ownership stays isolated; engine handoff works after an active turn; quota failures recover; same-engine retry and Stop and continue work; output and diff metadata are accurate.
- The full delivery loop works at an established repo URL, including two concurrent tasks affecting the same app: integrate and verify their combined result, identify what is ready for the user, and keep the conversation responsive meanwhile.
- Focused fake-backed tests and the checks in [AGENTS.md](AGENTS.md) pass, the app builds, and desktop and mobile flows are verified. Live checks are bounded and local models idle-only.
- Deliberate live checks cover real sleep and shutdown push, engine permission enforcement (`npm run check:workers` commits and runs a command in a worktree on each installed engine's cheapest model), background jobs surviving a turn, Claude subagent token accounting, and external host identity and attachment.
- Check upstream Claw session-event support and provider terms before changing agy's orchestration integration. New CLI support needs live verification, including Windows `.cmd` leader limitations.

## Deferred

Cloud workers, councils, custom ACP workers, repo filters, advanced creation and retry controls, per-model quota buckets, additional model and quota discovery, local workers, orchestration evals, preview links, admin-request notifications, Claude channels, and macOS. Stable Tailscale Service URLs also need tagging and identity verification. Implement these only when wanted.

Dedicated merge and acceptance UI is deferred; acceptance and feedback happen in the conversation. Moxy integrates through ordinary git and gh workflows; do not add a blind merge endpoint.
