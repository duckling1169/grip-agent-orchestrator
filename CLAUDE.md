# Grip

Grip lets any orchestrator model delegate to coding agents (Claude Code, Codex, Antigravity `agy`), and lets tailnet devices see and control those runs. It is a thin layer around [Claw Orchestrator](https://github.com/Enderfga/claw-orchestrator), which runs the agents.

**Read [DESIGN.md](DESIGN.md) before changing anything.** It is the agreed design; §17 is the build order.

## Layout

- `src/claw/`: Claw supervisor. Install within `>=7.23.4 <8`, run `clawo serve` on loopback with Grip's token, health gate, idle-only updates, rollback, crash restart. Also the Claw HTTP client.
- `src/runs/`:
  - `store.ts`: append-only `runs.jsonl` plus per-run turn files, and `waitAny`
  - `manager.ts`: delegate, message, stop, details, recovery
  - `briefs.ts`, `protected.ts`
- `src/git/`: worktrees (sibling `<repo>-worktrees/` folders on `grip/` branches), git facts, diffs. The parsers are copied from `agent-usage`.
- `src/mcp/`: the orchestrator MCP, stateless Streamable HTTP on `127.0.0.1:18797/mcp` behind a bearer token.
- `src/daemon.ts`, `src/cli.ts`: `grip serve` and `grip mcp-config`.
- `src/testing/`: fakes for tests.
- `scripts/`: manual smoke and end-to-end scripts against real Claw.

## Commands

- `npm run format:check`, `npm run typecheck`, `npm test`: all three must pass before work is done. CI runs them on Windows and Linux.
- `npm run format`: apply Prettier.
- `npm run dev -- serve`: run Grip. `npm run dev -- mcp-config`: print the orchestrator setup.
- `npm run smoke:supervisor`: supervisor against real Claw. `npx tsx scripts/mcp-e2e.ts <repo>`: delegate to every engine through a running `grip serve`.

## Rules

- **Official interfaces only:**
  - Codex app-server JSON-RPC, agy headless `-p --output-format json|stream-json`, Claude stream-json, Claw's HTTP API, Tailscale identity, OS power APIs.
  - No process-table or transcript scraping, no PTY tricks, no private endpoints, no OAuth tokens read from credential files.
- **No shell.** Spawn commands through `src/exec.ts`, which runs npm's own `npm-cli.js` on Windows.
- **Keep it light.** No extra infrastructure, mandatory contracts or approval steps. Add something only when it's needed.
- **Copied code keeps an origin comment** (`agent-usage`, `alethe-orchestrate`). Never import from those projects.
- **Tests never call real models.** Use `src/testing/fake-claw.ts`, fake servers and fixtures. Git tests use real temporary repos.
- Ask the user before committing or pushing.

## Running on the principal (Windows PC)

- **Run Grip and Claw from a normal logged-on terminal.** Under SSH (a network logon) or as a Windows service, agy and Codex can't reach their logins and Codex's sandbox won't start.
- **For manual tests, set `GRIP_HOME=C:\Users\you\claw-trial\grip-home`** so `~/.grip` stays clean. `C:\Users\you\claw-trial\sandbox` is a throwaway repo for real runs.
- **Prerequisites already installed:** Claw 7.23.4 and the Codex CLI (`@openai/codex`) are installed globally with npm. The Codex desktop app's bundled `codex.exe` is not a usable CLI.
- **Claw facts Grip relies on:**
  - `clawo-mcp` runs its own private session manager, so orchestrators must use Grip's MCP, never `clawo-mcp`.
  - `/session/send` blocks for the whole turn.
  - Plain sessions have no event stream.
  - `-w` only works for Claude, so Grip makes its own worktrees.
