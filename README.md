# Grip

Delegate from any orchestrator model to Claude Code, Codex and Antigravity workers, and watch and steer them from any device on your tailnet. Grip runs on [Claw Orchestrator](https://github.com/Enderfga/claw-orchestrator). [DESIGN.md](DESIGN.md) has the design and what's next.

## Set up (Windows)

Needs Node 22.12+, Tailscale signed in, and Claude Code, Codex and agy each signed in once.

```text
npm ci
npm run build
node dist/src/cli.js install
```

`install` adds what's missing (Claw, the Codex CLI, `tailscale serve`) and registers a logon task that runs Grip whenever you're logged on. It ends by printing the MCP config for your orchestrator. Open `https://<this machine>.<tailnet>.ts.net` on any of your devices; on iPhone, add it to the Home Screen for notifications.

Other commands: `status`, `stop-all`, `stop`, `restart` (after a build), `uninstall`, `serve` (run in a terminal instead of the task) and `mcp-config`.

## Settings

`~/.grip/config.json` lists the Tailscale logins allowed in (install fills in yours) and, optionally, timings. Restart Grip after editing it. The defaults are in `src/settings.ts`:

```json
{
  "allowedLogins": ["you@github"],
  "settings": {
    "quotaRefreshMinutes": 5,
    "modelListRefreshMinutes": 60,
    "clawUpdateCheckHours": 24,
    "turnTimeoutMinutes": 4320,
    "mcpSessionIdleDays": 7,
    "pushExpiryHours": 24
  }
}
```

The quota timer reads Claude with a one-line Haiku turn each time. Set `quotaRefreshMinutes` to 0 to turn it off.

## Develop

- `npm run format:check`, `npm run typecheck` and `npm test` must pass. Tests never call real models.
- `npm run web:preview` runs the app on loopback with a fake Claw and throwaway data. Add `npm run web:dev` in a second terminal for hot reload.
- [CLAUDE.md](CLAUDE.md) has the layout and the rules for agents working here.
