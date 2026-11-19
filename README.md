# Moxy

One persistent conversation that coordinates coding agents across repositories and providers, from any device on your tailnet. [DESIGN.md](DESIGN.md) describes the product; [IMPLEMENTATION.md](IMPLEMENTATION.md) describes how it is built and what comes next.

Moxy is under construction. Today it runs its database and Claw; workers, the conversation and the web app follow the build order in [IMPLEMENTATION.md](IMPLEMENTATION.md).

## Develop

Needs Node 24.11 or later and Claw installed globally:

```text
npm install -g "@enderfga/claw-orchestrator@>=7.23.4 <8"
npm ci
npm run dev -- serve --home <scratch folder>
```

Checks: `npm run format:check`, `npm run typecheck`, `npm test` and `npm run build`. Contributor rules are in [AGENTS.md](AGENTS.md).

## Credits

- [Claw Orchestrator](https://github.com/Enderfga/claw-orchestrator) by Enderfga runs Moxy's workers.
- [SQLite](https://sqlite.org), through Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html), stores Moxy's state.
- [semver](https://github.com/npm/node-semver) by the npm team checks Claw versions.

## License

MIT
