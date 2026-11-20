# Moxy usage

Any engine's worker can read `SKILL.md` and the relevant files in `reference/` directly. Treat command names as instructions to read the matching reference and perform the requested design work with the tools available to that worker. Read the project's existing product and design context directly, and read `reference/craft-floor.md` before UI edits. Follow the user's instructions and the host's permissions when upstream guidance calls for a launcher, subagents, installation or a host-specific command. The upstream launcher, agents, hooks and live-browser tools are not vendored here.

For an optional deterministic anti-pattern check, run `npx --yes impeccable@4.10.0 detect <path>` on a named source file or directory. This downloads the pinned npm package if it is not already cached. Detector findings are prompts for review, not proof of good or bad design. Use ordinary rendered desktop and mobile checks for visual verification.
