# Contributing to Luna

## Development Setup

Requirements: `bun` (see `package.json` `devEngines` for the pinned version). A Nix development shell (`flake.nix`) is also available (`nix develop`) and provides `bun` and `sqlite`.

```bash
bun install
bun run start     # start the daemon
bun run dev:web   # start the Vite web UI dev server
```

See `AGENTS.md` for repository layout and architecture notes.

## Checks Before Opening a PR

Run these checks locally before submitting:

```bash
bun run typecheck
bun run typecheck:web
bun test test/
```

If your change modifies configuration fields, HTTP/WebSocket endpoints, or tool schemas, update `CONFIGURATION.md` and `luna.config.example.json` in the same PR.

## Commit Style

Use Conventional Commits with an optional scope, matching the repository history:

- `feat(scope): short summary`
- `fix(scope): short summary`
- `web(scope): short summary`
- `chore(scope): short summary`
