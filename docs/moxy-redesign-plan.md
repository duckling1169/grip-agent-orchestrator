# Moxy Redesign & Consolidated Implementation Plan

**Plan status (2026-11-18):** Agreed scope, not an implementation-complete report. This repository copy is authoritative; update it here. The [plan index](plans.md) tracks related roadmap and follow-up work. This plan supersedes older design descriptions of multiple folder-bound chats and user acknowledgement of finished workers.

This plan merges the **Moxy** single-orchestrator architecture with the outstanding gaps identified in [API/app audit](audit-api-vs-app.md) and [DESIGN.md](../DESIGN.md) so the UI and backend are only built once.

---

## Confirmed Scope

- Use **Moxy** as the product and orchestrator name in the redesign.
- **Clean cutover:** preserving or migrating current Grip chats is not required. This does not authorize deleting repository files or worktrees.
- **Moxy reviews worker output.** User questions, approvals, and results belong in the main Moxy conversation; there is no separate Needs review sidebar group.
- **Active** includes running work and work awaiting or undergoing Moxy review. **Inactive** means reviewed and closed, or cancelled. Opening the inspector does not count as review.

## Target Architecture

- **One machine-wide orchestrator (`Moxy`):** Replaces multiple folder-locked `Chats (N)` with a single continuous stream on the machine (`Workstation`), able to work across any repo without manual `@tags`.
- **Any-model brain swapping:** Switch Moxy's `engine`, `model`, and `effort` mid-stream (e.g., Claude → Gemini 4 Hydrogen → Codex) with full context handoff and inline quota-exhaustion switch prompts.
- **3-Column Desktop UI / Bottom-Nav Mobile UI:**
  - **Left:** Task/Thread parents → nested Agents, grouped by **Active** and **Inactive** (showing active indicator, engine/model, repo, and purpose). No `+ New chat`.
  - **Center:** **Moxy** stream (always primary).
  - **Right (on click):** **Agent Inspector** (timeline, diff, logs, stop/retry/cancel, plus direct worker messaging preserved).

---

## Phase 1: Backend — Moxy Core, Engine Switching & Tasks

1. **Singleton Moxy Chat & Machine-Wide `cwd`**
   - Update `src/chats/store.ts` & `src/chats/manager.ts` to maintain a single Moxy orchestrator chat (no required `folder`; default `cwd` to user home or configured workspace root).
   - Remove the assumption that external MCP hosts create separate UI chats; any external CLI delegation simply attaches runs to the unified task/agent list.

2. **Zero-Tag Repo Resolution**
   - Build a lightweight known-repos index from `runs.jsonl` history, recent folders, and top-level workspace directories.
   - Surface known repos in Moxy's system prompt / MCP `list` or `repos` helper so Moxy resolves repo paths automatically from active tasks, recent turns, or known repos on disk.

3. **Task / Thread Grouping & Review State**
   - Add `taskId` / `taskTitle` (evolving `chat_title`) on runs and `delegate` in `src/mcp/tools.ts` and `src/runs/store.ts` so Moxy automatically groups related workers under a Task parent.
   - Track sidebar bucket state (`active` | `inactive`) separately from worker execution status. Finished or errored workers remain Active while awaiting Moxy review; show `Awaiting Moxy review` or `Moxy reviewing` as appropriate. Persist explicit review transitions and expose them through MCP so Moxy can mark review started and reviewed/closed; opening the inspector or fetching a result is not review completion. Cancellation can close work without review. A Task parent moves to Inactive when all its workers are reviewed and closed or cancelled, and the task itself is closed. Moxy brings results, questions, and approval requests to the user in the main conversation.

4. **Cross-Engine Handoff & Auto-Compaction**
   - Allow `POST /api/chats/:id/settings` (or `/api/moxy/settings`) in `src/web/server.ts` to change `engine` alongside `model` and `effort`.
   - Maintain a rolling structured summary + recent raw turns window (auto-compacting older turns when the raw window grows large).
   - When `engine` changes, clear `engineSessionId` and prepend a handoff block on the new engine's first turn: rolling summary + recent raw turns + live task/worker snapshot (`list`).

5. **Inline Quota-Exhaustion Signal**
   - When a Moxy turn fails due to quota exhaustion / rate-limit (or 0% remaining on that provider), attach structured switch metadata (exhausted provider, reset time, suggested fallback model) to the failed turn / SSE event. No proactive low-quota warnings.

6. **Audit Backend Fixes (Fold into Phase 1 APIs)**
   - **Per-turn model/effort & clipping metadata (`M4`, `M5`, `M9`):** Record `model` and `effort` on each worker turn in `src/runs/store.ts`; return `clipped: boolean` on truncated turns in `src/runs/present.ts`.
   - **Patch completeness (`M7`, `M8`):** Return `skippedFiles` reasons and distinguish `noTextPatch` / git collection failure from a clean working tree in `src/git/worktrees.ts` and `src/runs/present.ts`.

---

## Phase 2: Web UI Redesign (`web/src/`)

1. **Desktop 3-Column Shell (`workspace-layout.tsx`, `App.tsx`)**
   - **Left Sidebar (`navigation.tsx`):** Remove `+ New chat`. Render `Active` and `Inactive` sections with collapsible **Task parent → nested Agents** rows (active pulse/spinner, engine/model badge, repo name, purpose). Keep `+` for manual standalone workers.
   - **Center (`Moxy` stream):** Always-open Moxy conversation with inline engine/model-switch dividers and inline **Quota Exhausted** action cards (_"Claude is out of usage (resets at X). Switch to [Model] and retry?"_ with 1-click confirm).
   - **Right Column (`Agent Inspector`):** Opens/updates when clicking any agent in the sidebar. Displays brief, turns, collapsible per-file diff, git status, `Stop` / `Stop and continue` / `Retry` / `Cancel` controls (Stop preserves pending review; Cancel closes the work explicitly), and keeps the direct worker message composer.

2. **Mobile Layout**
   - Moxy stream as the default primary view with a bottom navigation bar (`Moxy` | `Agents` | `Inspector` / `Quota & Settings`).

3. **Audit UI Fixes (Fold into Phase 2 Components)**
   - **Same-agent retry (`Audit #1`):** Allow picking the original engine in `StartDialog` / retry flow.
   - **Live worker git refresh (`M1`, `Audit #2`):** Add `Refresh details` + last-fetched timestamp in Agent Inspector, plus bounded auto-refresh while the inspected worker is running.
   - **Active worker course-change (`Audit #6`):** Keep next-turn settings accessible while running and offer `Stop and continue`.
   - **Quota UI (`M2`, `M6`, `Audit #3`):** Tappable quota strip showing all windows, staleness, and errors; per-provider refresh (explicitly noting Claude's probe cost).
   - **Accurate labels (`M3`, `M4`, `M5`, `M7`, `M8`, `M9`, `M10`):** Label `Next-turn model`, rename `Elapsed` → `Time since started`, show `clipped` / `skippedFiles` / `No text patch` notices, fix single-device push test summary text, and add `Show all` on worktrees/Claw history.

---

## Phase 3: Deferred / Later Items (from `DESIGN.md §17`)

Keep out of scope for the initial Moxy cutover unless needed next:

- Repo filter controls (`Audit #9`); Active/Inactive grouping covers the initial status navigation needs
- Councils skill & dedicated council UI formatting (`DESIGN.md §17.4`)
- Cloud workers (Codex cloud / Claude web / Jules) (`DESIGN.md §17.5`)
- Lightweight native handoff (`claude --resume <id>` copy button) (`DESIGN.md §17.6`)
- Per-model-group quota buckets (e.g., `agy` Argon vs. Hydrogen)
- Local models (Ollama / LM Studio), Tailscale Service URL, macOS `grip install`, evals

---

## Implementation Order & Acceptance

1. Establish singleton persistence, task ownership and explicit review lifecycle APIs/MCP tools before rebuilding the UI. External host attachment must preserve worker ownership and permission boundaries.
2. Implement engine handoff and audit backend contracts, then the desktop/mobile shell and audit controls. Engine changes during a running turn take effect at the next turn boundary; handoff captures the completed turn before creating the new native session.
3. Verify singleton behavior after restart; worker completion through Moxy review and task closure; review states surviving restart; cross-engine context handoff; same-engine retry; stop-and-continue; patch completeness and quota failure metadata. Use focused tests and typecheck/build, followed by desktop and mobile browser checks. Live model checks must be deliberate and bounded to preserve usage; local models only when the PC is idle.
