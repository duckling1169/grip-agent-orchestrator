# Moxy

One persistent conversation that coordinates coding agents across repositories and providers, from any device on your tailnet. [DESIGN.md](DESIGN.md) describes the product; [IMPLEMENTATION.md](IMPLEMENTATION.md) describes how it is built and what comes next.

Moxy is under construction. It runs workers, tasks, the leader conversation and a desktop/mobile web app. Engine handoff and installation follow the build order in [IMPLEMENTATION.md](IMPLEMENTATION.md).

## Develop

Needs Node 24.11 or later and Claw installed globally:

```text
npm install -g "@enderfga/claw-orchestrator@>=7.23.4 <8"
npm ci
npm run dev -- serve --home <scratch folder>
```

Checks: `npm run format:check`, `npm run typecheck`, `npm test` and `npm run build`. Contributor rules are in [AGENTS.md](AGENTS.md).

`npm run web:preview` opens a fake-backed app at `http://localhost:18799`; it never calls real models. Run `npm run test:web` for desktop and mobile journeys.

## Models and quota

ACP engines report their models and model-specific effort choices when a session opens. Discovery sends no prompt and caches successful results for 30 minutes. Claude uses its CLI's Opus, Sonnet and Haiku choices; effort choices are shown only when reported by a provider.

Quota uses Codex app-server, Gemini's `agy /usage` and Claude's stream output. A table shows each provider's last check, a recheck action and the remaining 5h and 7d quotas. Usage tooltips show reset and observation times and staleness; unavailable providers have red family names with the error in a tooltip. Each Claude refresh spends one small Haiku turn with tools disabled and no saved session.

Automatic refresh defaults to every five minutes, beginning after the first interval, and includes Claude. Set `quotaRefreshMinutes` to `0` in Settings or `config.json` to disable it; supported intervals are whole minutes from 1 to 1440. Finishing a Codex or Gemini turn refreshes that provider, at most once per minute; finishing a Claude turn never probes Claude. Cached readings survive restart and stay marked stale after a reset or failed refresh.

## Notifications

Enable notifications in Settings on each device that should hear when a task is ready for you. Permission is requested only when you choose Enable notifications. Use the HTTPS Tailscale Serve address; on iPhone and iPad, add Moxy to the Home Screen and open it there first.

Subscriptions belong to the signed-in Tailscale login. Settings shows your registered device count, lets you disable this device, and can send a test to all your registered devices. Test results report how many notifications the push services accepted or rejected; they cannot confirm that a device displayed them. Expired subscriptions are removed automatically.

Task-ready notifications contain the task title and a link to its inspector, never code, output, repo paths or testing notes. Opening a notification does not accept the task. Repeating an unchanged delivery, restarting Moxy, and stopping or finishing workers do not send notifications. Push services retain an undelivered notification for at most 24 hours. Keys and subscriptions persist in `push.json` in Moxy's data home; only the public key and your device count are exposed through the API.

The fake preview and automated checks use fake push senders and browser subscriptions. Actual delivery to sleeping or closed devices still needs a deliberate live check through the HTTPS tailnet address.

## Credits

- [Claw Orchestrator](https://github.com/Enderfga/claw-orchestrator) by Enderfga runs Moxy's workers.
- [SQLite](https://sqlite.org), through Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html), stores Moxy's state.
- [semver](https://github.com/npm/node-semver) by the npm team checks Claw versions.
- [web-push](https://github.com/web-push-libs/web-push) encrypts notifications and signs requests with Moxy's VAPID keys.

## License

MIT
