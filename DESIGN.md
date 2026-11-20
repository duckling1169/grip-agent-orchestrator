# Moxy design

Moxy gives one user a persistent conversation for coordinating coding work on a Windows PC. The user can reach it from a phone on the tailnet. The leader plans and delegates work, reviews results, integrates changes and explains how to try them. [IMPLEMENTATION.md](IMPLEMENTATION.md) describes the implementation.

## Working loop

Tasks retain their plan, notes, testing instructions, workers and delivery state. Workers in Git repositories get separate worktrees and branches; workers outside a repository use the requested folder. The leader can continue a worker's native conversation. Moxy keeps worktrees and does not copy local configuration or `.env` files into them.

The leader reviews and verifies worker output before delivery. Integration commits remaining worker changes and merges into the repository's delivery branch when the checkout is suitable. `ready` marks a task Done and records how to try it. It refuses delivery while a task worker or integration is running. For a repository task, the revision must be a commit reachable from the delivery branch. Later integration can mark an earlier delivery superseded. Feedback can reopen a task.

Conversation, tasks and worker results survive restart. Messages and worker completions enter an inbox so the leader can respond while workers run. Engine, model and effort changes apply at the next turn boundary. Quota failures can offer a switch and retry.

## Interface

The desktop app shows the conversation, task sidebar and inspector. Tasks are grouped under Working, Reviewing and Done; workers without a task appear under Standalone workers. Mobile uses separate views for conversation, tasks, quota and settings. The inspector shows task details or a worker's output and changes. Users can message or stop workers, and stop a leader turn.

Messages can include up to 10 attachments of 25 MiB each. Pending uploads share a 250 MiB budget, must complete within 60 seconds, and expire after 24 hours if not attached to a sent message. Sent attachments remain available. Images open inline and other files download.

Quota checks cover Codex, Gemini and Claude. Claude checks spend a small Haiku turn; the default five-minute timer includes Claude and can be disabled in Settings. Notifications are opt-in per device and contain the task title and a link, not code or output.

## Boundaries

Services bind to loopback; Tailscale Serve exposes the web app and API. Remote access requires an allowed Tailscale login, and an explicit empty `allowedLogins` list allows nobody. Writes check Host and Origin. A local process that can reach loopback is trusted, including to supply identity headers. The CLI uses a local bearer token, and shutdown is local-only.

Workers run as the Windows user and have network access. Codex and agy workers run with full access. Worktrees separate changes, not permissions. Keep Claw and MCP credentials private; workers do not receive leader delegation tools. Install preserves existing Serve mappings, and uninstall preserves data, Claw and Serve configuration.

## Not built yet

External-host worker attachment, worktree cleanup, overlap warnings and a fresh-worker Retry are not implemented. Dedicated merge and acceptance UI is also deferred; feedback happens in the conversation.
