# Grip

Grip lets any orchestrator model delegate to coding agents (Claude Code, Codex, Antigravity `agy`), and lets tailnet devices see and control those runs. It is a thin layer around [Claw Orchestrator](https://github.com/Enderfga/claw-orchestrator), which runs the agents.

**Read [DESIGN.md](DESIGN.md) before changing anything.** It is the agreed design; §17 is the build order.

## Layout

- `src/claw/`: Claw supervisor. Install within `>=7.23.4 <8`, run `clawo serve` on loopback with Grip's token, health gate, idle-only updates, rollback, crash restart. Also the Claw HTTP client.
- `src/chats/`: chats (DESIGN §5.1). `turns.ts` is how a leader runs a turn: Claude through Claw, others through `acp-turns.ts`, an ACP client on the official SDK that gives the leader Grip's MCP in `session/new`. `leaders.ts` has the ACP presets (agy, Codex through `codex-acp`), the `mcp-remote` bridge and the leader check.
- `src/runs/`:
  - `store.ts`: append-only `runs.jsonl` plus per-run turn files, and `waitAny`
  - `manager.ts`: delegate, message, stop, details, recovery
  - `briefs.ts`, `protected.ts`
- `src/git/`: worktrees (sibling `<repo>-worktrees/` folders on `grip/` branches), git facts, diffs. The parsers are copied from `agent-usage`.
- `src/quota/`: quota windows (DESIGN §8). Parsers ported from `alethe-orchestrate`, wording copied from `agent-usage`. Codex through its own short-lived app-server client, agy through `agy -p /usage`, Claude only through an on-demand probe.
- `src/mcp/`: the orchestrator MCP, stateful Streamable HTTP on `127.0.0.1:18797/mcp`. Each session is bound to its opening install/chat token; tools associate workers with their chat (DESIGN §5.1). Session handling follows the official TypeScript SDK v1.x examples.
- `src/web/`: the device web API and SSE on `127.0.0.1:18798`, behind Tailscale identity (`Tailscale-User-Login` checked against `allowedLogins` in `~/.grip/config.json`, which Grip fills with this machine's Tailscale owner on first start). Writes must be JSON from Grip's own origin or another Grip machine on the same tailnet (CORS, for the app's machine switcher).
- `web/`: React 19 + Vite app with Tailwind v4 and shadcn/ui (`web/src/components/ui`, from the shadcn registry; keep them as shadcn ships them). Built into `web/dist` and served by that same identity-checked web server. Hash routes select chats and workers; EventSource keeps state current. No runtime demo mode, transcript cache, or exposed MCP token. Native handoff remains follow-up work.
- `src/settings.ts`: every tunable timing (quota timer, model list refresh, Claw update checks, turn timeout, MCP session idle) with its default. `~/.grip/config.json` overrides them under `settings`. Add new timings here, not as constants in the module that uses them.
- `src/engines.ts`: every engine Claw runs a worker on, with its Claw engine, ACP preset, permission mode and CLI, and the PATH lookup that tells which are installed. Add an engine here.
- `src/models.ts`: each agent's models for the app's pickers. Codex through app-server `model/list`, agy through `agy models`, Claude from a fixed list because Claude Code has no list command.
- `src/push/`: Web Push (DESIGN §13). `web-push.ts` sends through the `web-push` library; `notifier.ts` keeps keys and devices in `push.json` and turns run and Claw events into notifications.
- `src/power/`:
  - keep-awake while runs work: a PowerShell helper holds `SetThreadExecutionState` on Windows, `caffeinate` on macOS
  - the sleep and shutdown watcher (`SystemEvents` through PowerShell) for the going-offline push
  - the never-elevated check
- `src/install/`: `grip install`, `uninstall`, `status`, `stop-all`, `stop` and `restart` (DESIGN §15):
  - the `schtasks` logon task, run through `conhost --headless`
  - `tailscale serve`, set only when nothing serves the HTTPS root
  - the local API client, which uses the MCP token as a bearer
- `src/daemon.ts`, `src/cli.ts`, `src/log.ts`: `grip serve` (it logs to `~/.grip/logs/grip.log`) and the other commands.
- `src/testing/`: fakes for tests.
- `scripts/`: manual smoke and end-to-end scripts against real Claw.

## Commands

- `npm run format:check`, `npm run typecheck`, `npm test`: all three must pass before work is done. CI runs them on Windows and Linux.
- `npm run format`: apply Prettier.
- `npm run build`: compile the daemon and build the web app. Node 22.12+ is required by the frontend toolchain. `npm run typecheck` checks both backend and frontend; `npm test` explicitly excludes compiled test copies.
- `npm run web:preview`: isolated loopback preview at port 18799 with fake Claw and temporary data; never use this identity-injecting development proxy in the daemon. `npm run web:dev` starts Vite with the preview as its API proxy.
- `npm run dev -- serve`: run Grip. `npm run dev -- mcp-config`: print the orchestrator setup.
- `npm run build`, then `node dist/src/cli.js install`: register the logon task. Its definition records this Node and this `cli.js`, so rebuild after changes and run `node dist/src/cli.js restart` (with `--home` or `GRIP_HOME` when the task uses one). It refuses while runs or chats work. `schtasks /End` does not stop Grip: Grip keeps running after its headless console is gone.
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

- **Run Grip and Claw from the `Grip` logon task or a normal logged-on terminal.** Under SSH (a network logon) or as a Windows service, agy and Codex can't reach their logins and Codex's sandbox won't start.
- **For manual tests, set `GRIP_HOME=C:\Users\you\claw-trial\grip-home`** so `~/.grip` stays clean. `C:\Users\you\claw-trial\sandbox` is a throwaway repo for real runs.
- **Prerequisites already installed:** Claw 7.23.4 and the Codex CLI (`@openai/codex`) are installed globally with npm. The Codex desktop app's bundled `codex.exe` is not a usable CLI.
- **Claw facts Grip relies on:**
  - `clawo-mcp` runs its own private session manager, so orchestrators must use Grip's MCP, never `clawo-mcp`.
  - `/session/send` blocks for the whole turn.
  - Plain sessions have no event stream.
  - `-w` only works for Claude, so Grip makes its own worktrees.
