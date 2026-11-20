# Contributing to Moxy

Read the relevant code and tests before editing; consult [DESIGN.md](DESIGN.md) for behavior and [IMPLEMENTATION.md](IMPLEMENTATION.md) for architecture.

## Changes

- Keep edits focused on the requested behavior. Preserve unrelated work and avoid incidental refactors.
- No legacy code, deprecated paths, compatibility shims, aliases or migrations. Replace code outright and delete what it replaces.
- Name things well and keep code DRY. Reuse existing helpers and dependencies. Add abstractions only when they remove demonstrated duplication.
- Do not write explanatory code comments. Names, types and small functions explain the code. Attribution is not a comment to remove: credit the source of copied or adapted code, ideas and designs early and often.
- Spawn application commands through `src/exec.ts` without a shell.
- Preserve authentication, worker ownership and secret-handling boundaries. Keep shadcn primitives unchanged; compose them in application components.
- Use official interfaces: Claw HTTP, ACP/MCP SDKs, Codex app-server, agy headless commands, Claude stream-json, Tailscale identity, and OS APIs. No process/transcript scraping, PTY tricks, private endpoints, or reading OAuth tokens from credential files.
- Keep documentation aligned with behavior. Ask before committing or pushing.

## Tests and verification

- For bug fixes and behavior changes, write or update a focused test first. Confirm it fails for the intended reason, implement the smallest fix, then refactor with tests green.
- Test observable behavior and failure cases, not implementation details. Avoid tests for prose edits or trivial changes that add no useful coverage.
- Automated tests never call real models. Use `src/testing/`, fixtures and temporary git repos. Live checks must be deliberate, bounded and isolated from normal user data.
- Run focused tests while iterating. Before finishing code changes, run `npm run check` for formatting, lint, type checking, unit tests and build. Run Playwright separately with `npm run test:web`.
- For documentation-only changes, check formatting and links. For UI changes, verify desktop and mobile flows with the fake-backed `npm run web:preview`.
- Report what changed, checks run and any failures or blockers. Never claim a check passed if it did not run.
