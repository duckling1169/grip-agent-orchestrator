# Moxy

One persistent conversation that coordinates coding agents across repositories and providers, from any device on your tailnet. [DESIGN.md](DESIGN.md) describes the product; [IMPLEMENTATION.md](IMPLEMENTATION.md) describes how it is built and what comes next.

## Install

Moxy installs on Windows. It needs Node 24.11 or later and Tailscale signed in. Run it from a normal terminal, not an elevated one:

```text
npm ci
npm run build
node dist/cli.js install
```

Install does these steps, and it is safe to run again:

1. It installs Claw (`@enderfga/claw-orchestrator`, `>=7.23.4 <8`) when no supported release is installed.
2. It allows the signed-in Tailscale login to use Moxy, through `allowedLogins` in `~/.moxy/config.json`.
3. It publishes Moxy on your tailnet with `tailscale serve --bg 18798`. If something else already serves this machine's HTTPS root, install leaves it unchanged and prints the command for you to run.
4. It registers a Windows logon task named Moxy. The task starts Moxy when you log on, with your normal rights and no window, and restarts it if it fails. Moxy logs to `~/.moxy/logs/moxy.log`.
5. It starts Moxy, unless Moxy already runs. In that case, run `moxy restart` to move it to the task.

Then open `https://<this machine's tailnet name>/` on any of your tailnet devices. While a turn or worker runs, Moxy keeps the machine from sleeping; the display can still turn off.

To tell Moxy where your repositories are, add their parent folders to `repoFolders` in `~/.moxy/config.json`, for example `"repoFolders": ["C:\\Users\\you\\Code"]`, then run `moxy restart`. Moxy lists the git repositories it finds up to three levels down in its Orchestrator's instructions. Without `repoFolders`, Moxy asks you for a repository's path.

The Orchestrator works in `~/.moxy/workspace`, not your home folder, so the Claude Code memory you keep for your home folder does not reach it. Moxy's own memory holds your standing instructions and preferences.

| Command             | What it does                                                                       |
| ------------------- | ---------------------------------------------------------------------------------- |
| `moxy status`       | Shows whether Moxy runs, its logon task, Tailscale, Claw and what is working       |
| `moxy stop`         | Stops Moxy when nothing works; `--force` stops it anyway                           |
| `moxy restart`      | Stops Moxy and starts it again through its logon task, for example after a build   |
| `moxy upgrade-claw` | Stops Moxy, installs the newest Claw in the supported range, and starts Moxy again |
| `moxy uninstall`    | Removes the logon task. Moxy's data, Claw and `tailscale serve` stay               |
| `moxy say <text>`   | Sends Moxy a message and prints its reply                                          |

Claw never upgrades itself; `moxy upgrade-claw` is the only way it changes. Run the commands with `node dist/cli.js <command>`, or put `moxy` on your PATH with `npm link`. Only a command on Moxy's own machine can stop Moxy.

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

## Machines

Click the machine name in the header to open the machine switcher. It lists the current machine first and offers links to other tailnet computers whose public `/health` identifies Moxy. Tailnet connectivity and Moxy availability are shown separately; offline computers and unconfirmed apps cannot be selected.

Discovery uses `tailscale status --json` and HTTPS names within this machine's tailnet DNS suffix. Reads are cached for 30 seconds; Refresh machines checks again. Health checks have bounded concurrency and timeouts and send no authentication credentials. Last-loaded links remain available while the page stays open if discovery fails.

Choosing a machine navigates to that machine's own Moxy page. It starts with that machine's conversation and access rules; no task selection, API bearer or session state is forwarded. The fake preview supplies fixture machines, and browser journeys intercept destination navigation without contacting real tailnet peers.

## Credits

- [Claw Orchestrator](https://github.com/Enderfga/claw-orchestrator) by Enderfga runs Moxy's workers.
- [SQLite](https://sqlite.org), through Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html), stores Moxy's state.
- [semver](https://github.com/npm/node-semver) by the npm team checks Claw versions.
- [web-push](https://github.com/web-push-libs/web-push) encrypts notifications and signs requests with Moxy's VAPID keys.

## License

MIT
