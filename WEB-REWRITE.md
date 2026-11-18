# Brief: rewrite the web app with React and shadcn/ui

Read CLAUDE.md and DESIGN.md §12 first. This brief is the spec for one job: rewrite `web/` from Preact plus hand-written CSS to **React 19 + Tailwind CSS v4 + real shadcn/ui components**. The user chose this so the app follows one maintained standard (https://ui.shadcn.com/docs/components) instead of custom styling. Delete this file when the job is done.

## Boundaries

- Change only `web/`, `package.json`, `package-lock.json`, `vitest.config.ts` if needed, and README.md's web section. **Do not edit `src/`, `scripts/` or DESIGN.md.** Another agent is changing the backend at the same time. It is adding `GET /api/machines`, described below.
- Do not commit. Do not run real models. Do not start or stop `grip serve`; port 18798 belongs to the user's running Grip.
- The app keeps calling the same API in `web/src/api.ts` (plus the new machines call). Types still come from `../../src/...` type-only imports, as `web/src/types.ts` does today.
- Keep the security properties: no `dangerouslySetInnerHTML` except the existing DOMPurify-sanitized Markdown, no external network requests at runtime (self-host any font, no CDN), and the service worker caches no API data.

## Setup

- React 19 and react-dom, `@vitejs/plugin-react`, Tailwind v4 through `@tailwindcss/vite`, and the shadcn CLI (`npx shadcn@latest init`, then `add`) with a `web/components.json`. Use the `@/` alias for `web/src`. Pick the **neutral** base color. The theme follows the system with a `dark` class set from `prefers-color-scheme`.
- Add only components you use, for example: button, dialog, alert-dialog, sheet or drawer, collapsible, dropdown-menu, select, input, textarea, scroll-area, badge, progress, separator, tooltip, sonner. Icons come from `lucide-react`, the shadcn default.
- Remove Preact, `web/src/styles.css` and every hand-written class style. Keep only a small `index.css` with the Tailwind import, the shadcn theme variables, and the agent colors below.
- Keep the scripts `web:dev`, `web:build`, `web:preview`, `typecheck` (both tsconfigs) and `test`. Keep `npm run format:check` passing; Prettier already covers `web/`.

## Agent identity

The only custom color. Every agent mark uses these, as small lucide or text marks:

- Claude: ✻, terracotta `#d97757`
- Codex: ◆, green `#5fb98a`
- Antigravity: ▲, blue `#7aa5f0`

Status uses shadcn's standard foreground, muted and destructive colors. Amber is the one exception: it's only for something that needs the user.

## Layout and screens

Desktop (≥ 768px): sidebar on the left, selected chat or worker on the right. Phone: full-screen list, then full-screen chat or worker with a back button. Hash routes stay as they are (`#/chats/<id>`, `#/runs/<id>`).

**Header:**

- The Grip logo **once** (the icon, or the word, not both).
- A **machine switcher**: a dropdown button showing this machine's name and a status dot. It opens a list from `GET /api/machines` (shape below). This machine has a check mark. Other machines running Grip are links to their `url`, which loads that machine's own Grip in the same tab. Machines without Grip are listed greyed, with "Grip not running". Show each machine's tailnet IP in small muted text.
- A **settings menu** (dropdown, lucide `Settings`) holding Worktrees, Claw updates and settings (today's SettingsDialog content), and **Stop all**, marked destructive and followed by a confirm alert-dialog.
- Nothing else in the header.
- **iOS safe area:** installed to the home screen, iOS draws a blurred band under the status bar. The header's top padding is `calc(env(safe-area-inset-top) + 12px)`, so no header text sits in the band. Full-screen sheets get the same top padding.

**Sidebar (or the phone's home list), top to bottom:**

1. **Needs you**, shown only when something needs the user: a collapsible section titled "Needs you (n)" in amber, listing failed or stopped workers with Continue and "Retry with another agent". No big filled block.
2. **Chats (n)**: a collapsible section, open by default. Each chat row has the agent mark, title and folder name, and a working or waiting dot. Its workers are nested under it with a thin left line, one level. Chat rows are separated by a `Separator`. Header button: "New chat".
3. **Independent workers (n)**: collapsible, with the same row style as nested workers. Header button: start one worker.
4. **Quota**, a footer pinned at the bottom of the sidebar, always shown, not collapsible. One column per agent. Each column has **two stacked bars: the 5-hour window and the weekly window**, each with "x% left" and "resets in …". Use the provider's windows named `5h` and `week`. Other windows, such as agy's `argon` and `3p-*`, are not shown. If a window has no reading, show "—". Add a small refresh icon button that calls `api.refreshQuota()`. **No verdict sentence** ("Plenty of room everywhere" and the like) and no other explanatory text.

- Each collapsible remembers its open state in `localStorage`, wrapped in try/catch.
- Section titles share one style: the shadcn small muted label. Row titles share one size. Row details share one size. No mixed font sizes for the same role.

**Chat deletion:**

- On touch: swipe a chat row left to reveal Delete, or long-press it.
- On a pointer device: right-click, or a hover `…` dropdown with Delete.
- Every route confirms in a small centered **AlertDialog** (shadcn alert-dialog), never a full-screen sheet. Title: "Delete chat?". Description: one sentence, "<title> and its n workers leave your list. Files stay on disk." Buttons: Cancel and Delete (destructive).
- Call `api.deleteChat(id)`. The server then sends `chat-deleted` over SSE; `state.ts` already handles it. Keep that reducer.

**Start a chat / Start one worker / Retry:**

- A shadcn Dialog on desktop and a Sheet or Drawer from the bottom on phones. The actions sit at the bottom.
- Fields:
  - Agent: a radio group of three rows. For chats, Codex and Antigravity are disabled with "Worker only".
  - Folder: an input plus a Browse button. Browse opens a nested dialog: breadcrumbs (`pathTrail` in `web/src/paths.ts`), a filter input, a scrollable list (Recent and Places on the start view, git badge on repos), and "Use <folder>".
  - Model and Effort: Selects fed from `api.models()`. Keep the current behavior: model labels; efforts follow the chosen model, or the union of the agent's efforts when no model is chosen; agy's efforts read "Set by the model".
- Chats have no first-message field. Workers keep the brief field.

**Chat and worker views:** keep everything they show today (timeline, worker cards, diffs, Markdown, composer, Stop, Retry, Continue). Rebuild them with shadcn primitives: Card, Badge, Button, Textarea, ScrollArea. The composer stays pinned at the bottom with `env(safe-area-inset-bottom)`.

**Small confirmations:** stop chat, stop worker, Stop all and remove worktree all use AlertDialog.

**Copy:** cut decorative or explanatory text that tells the user what they can see. Keep error messages specific. Sentence case. No all-caps labels.

## Faster reconnect

`state.ts` uses EventSource. Add:

- On `visibilitychange` to visible, and on `online`, reconnect at once if the stream is not OPEN. Close it and open a new EventSource; the server sends a full `state` event first.
- While the page is visible and the stream is in error, retry every 1 s, not the browser's default. The server will also send `retry: 1000`.
- An offline banner shows only after 2 s offline, so a quick reconnect doesn't flash it.

## Machines API (the backend agent adds this)

`GET /api/machines` returns:

```ts
type Machine = {
  name: string // Tailscale host name, e.g. "windows-pc"
  dnsName: string // "windows-pc.example-tailnet.ts.net"
  ips: string[] // tailnet IPs, IPv4 first
  os: string
  online: boolean
  self: boolean // the machine this Grip runs on
  grip: 'yes' | 'no' | 'unknown' // whether Grip answers on that machine
  url: string | null // "https://<dnsName>/" when grip is 'yes', else null
}
type Machines = { machines: Machine[] } // self first, then online Grip machines, then the rest
```

The type will be exported from `src/web/machines.ts` as `Machine` and `MachineList`. Import it type-only. Until that file exists, declare the same type locally in `types.ts` and switch to the import later. Fetch it when the switcher opens, with a short loading state.

## Verification

- `npm run format:check`, `npm run typecheck` and `npm test` pass. Keep and port `web/src/state.test.ts` and `web/src/paths.test.ts`, and add tests for any new pure logic, such as quota window picking.
- `npm run web:build` succeeds. Report the gzipped JS size.
- Run `npm run web:preview` (port 18799, fake data, no models). Check the app at 390×844 and 320×700 in a headless browser: no horizontal overflow; header, sections, quota footer, start sheet, folder picker and the delete alert all usable. Report what you checked and anything you couldn't. Stop the preview when done. If port 18799 is busy, find out whether it's a stale preview before stopping it.

When finished, list the changed files, the checks and their results, and anything left undone.
