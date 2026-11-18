# Brief: switch between Grip machines in one app

Read CLAUDE.md and DESIGN.md §12 first. This brief is the spec for one job. Delete this file when the job is done.

## Goal

The user installs the app once, from one machine's address, for example `https://windows-pc.<tailnet>.ts.net`. The header's machine switcher then shows any other tailnet machine that runs Grip. Picking one shows that machine's chats, workers and quota in the same app, without leaving it. Each Grip stays independent: no machine forwards to another, and nothing merges machines onto one page.

The target machine must already run Grip and `tailscale serve`. The app cannot start Grip on another machine.

## How it works

The page always loads from the installed origin. The app sends its API calls and its EventSource stream to the chosen machine's base URL (`Machine.url` from `GET /api/machines`). Each machine checks the caller's Tailscale identity against its own `allowedLogins`, as it does now.

## Backend (`src/web/`)

- **Tailnet origins.** At start, read this machine's tailnet suffix from `tailscale status --json` (`Self.DNSName` without the host label, for example `.example-tailnet.ts.net`). If Tailscale can't be read, allow no other origins. Keep the suffix in a small function that tests can inject, like `listMachines`.
- **CORS on `/api/*` and `/health`.** For a request whose `Origin` is `https://<name><suffix>` (https only, one host label, no port), send:
  - `Access-Control-Allow-Origin: <that origin>`, `Vary: Origin`
  - `Access-Control-Allow-Credentials: true`, in case `tailscale serve` ever needs cookies; harmless otherwise.
  - Send nothing for any other origin.
- **Preflight.** Answer `OPTIONS /api/*` from an allowed origin with 204, `Access-Control-Allow-Methods: GET, POST, DELETE`, `Access-Control-Allow-Headers: Content-Type`, `Access-Control-Max-Age: 600`. Answer 403 for other origins. Preflight carries no identity, so it must reveal nothing.
- **Writes.** `crossSiteWrite` in `src/web/identity.ts` gains an `allowedOrigin(origin)` check: same host as today, or an allowed tailnet origin. Content-Type must still be `application/json`. `Origin: null` stays refused.
- **SSE.** `/api/events` gets the same CORS headers, so EventSource works across origins.
- **Identity is unchanged.** Every request, CORS or not, still passes the `Tailscale-User-Login` check first. `tailscale serve` sets that header on each machine for requests from the user's devices.

## Frontend (`web/`)

- **Chosen machine.** Store the chosen machine's base URL in `localStorage` (key `grip.machine`), with every read and write in try/catch. Missing or unreadable means this origin.
- **`api.ts`.** Every request path and the EventSource URL go through one `apiUrl(path)` helper that prefixes the base. When the base is another origin, use `credentials: 'include'` on fetch and `withCredentials: true` on EventSource.
- **Switcher.** Picking a Grip machine sets the base, closes the old stream, clears state, and opens the new stream (the server sends a full `state` event first). Do not navigate away. The header shows the chosen machine's name. "This device" marks the machine that served the page.
- **Hash routes** stay per machine: switching goes to the home list, because chat and run ids are local to each Grip.
- **Unreachable machine.** If the chosen machine doesn't answer within the normal reconnect wait, show "<name> is not answering" with buttons to retry and to switch back to the serving machine. Never switch silently.
- **Machines list.** Always ask the serving machine's `/api/machines`, so the list is the same whichever machine is chosen.

## Service worker (`web/public/sw.js`)

So the app opens even when the machine that served it is off:

- Cache the app shell only: `index.html`, the hashed `/assets/*` files, icons and the manifest.
- Navigation requests: network first, cached `index.html` on failure.
- Hashed assets: cache first.
- **Never cache `/api/*`, `/health`, or any response from another origin.** Update the comment at the top of `sw.js` to say what is cached and why that is safe (the shell holds no user data).
- Bump the cache name on each build, and delete old caches on `activate`.

## Tests

- Backend: allowed and refused origins (other suffix, http, port, nested label, `null`); CORS headers present only for allowed origins; preflight 204 and 403; a cross-origin JSON write from an allowed origin passes and from another origin fails; identity is still required on a CORS request; SSE carries the headers.
- Frontend: `apiUrl` with no base, same-origin base and another base; the stored base read with storage throwing; switching clears state.

## Docs

Update DESIGN.md §12 (machine switcher), README's web section, and CLAUDE.md's `src/web/` line. Say plainly that each machine needs its own `grip serve` and `tailscale serve`.

## Verification

`npm run format:check`, `npm run typecheck`, `npm test`, `npm run build`. In the preview, fake a second machine (a second preview on another port, with the origin check pointed at loopback in the test hook only) and check that switching shows its data and that switching back works.
