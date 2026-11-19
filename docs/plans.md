# Moxy plan index

Updated 2026-11-18. All agreed planning for Grip's transition to **Moxy** is maintained in this repository. This index records scope and disposition; it does not claim that planned features have shipped.

## Source documents and precedence

- [Moxy implementation plan](moxy-redesign-plan.md): authoritative next architecture, initial cutover scope, implementation order, and acceptance checks. Consolidated from the external Antigravity plan and the subsequent user decisions.
- [API versus app audit](audit-api-vs-app.md): detailed findings M1–M10 and ranked daily-driver gaps, with implementation evidence. This is a static audit; its historical status notes are not runtime verification.
- [Design](../DESIGN.md): existing architecture, original build order (§17), and unresolved implementation questions (§18). Moxy supersedes conflicting descriptions of multiple folder-bound chats and review acknowledgement; unrelated constraints remain applicable.
- [Contributor guidance](../CLAUDE.md): implementation and verification rules.

## Initial Moxy cutover

The implementation plan contains the detailed work. Its agreed scope is:

- Moxy product/orchestrator naming and a single persistent machine-wide conversation; no current-chat migration requirement.
- Automatic repo resolution, task/thread parents, worker ownership, and persistent review transitions controlled by Moxy.
- Active work includes running workers and work awaiting or undergoing Moxy review. Inactive work is reviewed and closed, or cancelled. User questions, approvals, and results stay in the Moxy conversation.
- Engine/model/effort switching, structured summaries and context handoff, and inline quota-exhaustion recovery.
- Three-column desktop UI and mobile bottom navigation, retaining the inspector and direct worker messaging.
- Audit fixes: same-engine retry; bounded live git refresh; Stop and continue and active next-turn settings; provider quota details and refresh costs; per-turn model/effort; clipping and skipped-file metadata; unavailable/binary diff states; accurate elapsed and push labels; worktree/history scope and Show all.
- Focused tests, typecheck/build, and desktop/mobile browser verification, including persistence, review lifecycle, handoff, and recovery. Automated tests never invoke real models. Deliberate live checks must be bounded; local models run only when the PC is idle.

## Audit disposition

| Audit items                                         | Disposition                                                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1–M10 and ranked gaps 1–8                          | Included in the initial Moxy backend/UI work.                                                                                                                                         |
| Rank 0: ACP reply streaming                         | Audit records it as implemented; preserve it through the redesign. Claude/Claw completed-reply behavior remains a known limitation.                                                   |
| Rank 9: folder/status filters                       | Active/Inactive groups cover initial status navigation; repo filtering is deferred.                                                                                                   |
| Rank 10: housekeeping                               | Scope labels and Show all are included. A narrow MCP worktree-cleanup tool remains optional follow-up; existing manual cleanup remains available.                                     |
| Rank 11: native handoff                             | Deferred; verify resume support per engine before exposing commands.                                                                                                                  |
| Rank 12: merge/review and councils                  | Moxy performs review and brings decisions to the conversation. Dedicated councils and direct merge/acceptance UI are deferred; no blind merge endpoint is planned.                    |
| Rank 13: title, edited-brief retry, external rejoin | Optional follow-up: worker creation titles and advanced retry editing. External-host identity plumbing must remain compatible with unified task attachment and permission boundaries. |
| Rank 14: creation extras and API symmetry           | Low priority: creation-time first message and initial mute preferences. SSE already serves passive waiting. Shutdown remains local-only.                                              |

## Retained follow-up work

These items from Design §17 remain recorded, outside the initial cutover unless an implementation dependency requires one:

- Councils: orchestration skill first, task/group display, then dedicated formatting once the workflow is known.
- Cloud workers through official Codex cloud, Claude web, and Jules interfaces; vendor task IDs, pushed GitHub code, and fetched branches for review.
- Lightweight native handoff: open folder or copy a supported resume command; fuller native continuity only as needed.
- User-configured ACP worker presets when wanted; live verification of newly supported CLIs and the Windows `.cmd` leader limitation.
- Per-model-group quota buckets and model/quota discovery for additional engines, which currently use defaults or show unknown quota.
- Stable Tailscale Service URL; macOS install, claim/principal switching, and keep-awake parity.
- Local workers through Ollama/LM Studio and Claw ACP/custom engines, only while the PC is idle.
- Intentional model orchestration evals, separate from automated tests.
- Dev-server preview links on runs, the admin-request flow, and Claude channels pushing into the orchestrator.

## Daily-use and upstream checks

Retain these checks from Design §§17–18 alongside the implementation:

- Daily use and a real sleep/shutdown notification check.
- Protected-path enforcement per engine; Claude worker denial of every Grip MCP tool, including user-configured tools.
- Codex/agy background jobs or subagents surviving turn completion, and Claude subagent token accounting in Claw's ledger.
- External Claude host session identity and attachment behavior; the older per-chat assumption must be reconciled with singleton Moxy rather than blindly reproduced.
- Tailscale Service tagging and identity headers before adopting a Service URL.
- Verify current provider terms for agy's third-party orchestration before changing that integration.
- Upstream Claw session-events issue and support for live activity in the app and MCP list/result. Nothing else waits on this.

The resolved quota questions in Design §18 remain historical context, not new work. Product naming is settled as **Moxy**. Original build steps 1–13, the scenario suite, and the static API/app audit are recorded as completed in their source documents; the cutover must preserve their applicable behavior.
