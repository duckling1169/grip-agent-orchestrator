# Grip

Grip coordinates coding agents and makes their runs visible to devices on your tailnet. See [DESIGN.md](DESIGN.md) for the design and build status.

Requires Node 22.12 or newer. Install dependencies with `npm ci`, then run `npm run build` to compile the daemon and build the Preact web app into `web/dist`.

Run Grip with `npm run dev -- serve` in a normal logged-on terminal. Open its Tailscale Serve HTTPS address to use the app; direct loopback access has no Tailscale identity and is refused. The same identity check protects the HTML, assets, API and event stream. See CLAUDE.md for the machine setup and manual-test home directory.

The app shows chats and their workers, live status, quota, conversation history, worker output/diffs, and worktree cleanup. It supports starting, messaging, stopping and retrying workers, plus Claude-hosted chats. Codex and Antigravity can run as workers; hosting their orchestrator chats inside Grip still needs upstream Claw support. Native-app handoff and Web Push are follow-up work.

For an isolated interface preview:

```text
npm run web:build
npm run web:preview
```

Open the printed loopback URL. The preview uses temporary data and a fake Claw; it does not launch models or read your Grip state. Stop it with Ctrl+C. Its identity-injecting proxy is for local development only. For hot reload, keep that preview running and launch `npm run web:dev` in a second terminal; Vite proxies API calls to the isolated preview.

Run `npm run format:check`, `npm run typecheck`, `npm test`, and `npm run build` before delivering changes. Tests use source files only, so running a build first does not duplicate compiled tests. Browser screenshots in `web/shots` and design-tool state in `.taste-skill` are ignored.

## Settings

`~/.grip/config.json` holds the Tailscale logins that may use the web app and, optionally, Grip's timings. Restart Grip after editing it. Leave out any setting to keep its default:

```json
{
  "allowedLogins": ["you@github"],
  "settings": {
    "quotaRefreshMinutes": 5,
    "modelListRefreshMinutes": 60,
    "clawUpdateCheckHours": 24,
    "turnTimeoutMinutes": 120,
    "mcpSessionIdleDays": 7
  }
}
```

The quota timer reads Claude too, with a one-line Haiku turn each time. Set `quotaRefreshMinutes` to 0 to turn the timer off. The defaults live in `src/settings.ts`.
