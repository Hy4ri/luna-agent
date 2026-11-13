# Luna

A self-hosted, durable AI agent that runs on your own machines.

Repository: [github.com/Hy4ri/luna-agent](https://github.com/Hy4ri/luna-agent)

Luna runs as a local HTTP/SSE daemon with a built-in web UI, an optional CLI (`bun run chat`), and an optional Tauri desktop shell (`src-tauri/`). Sessions and task state are persisted to SQLite so conversations survive restarts. It supports multiple model providers and can run commands on remote worker machines.

## Features

- **Sessions and durability:** Persistent SQLite-backed sessions, task lists, and goals that resume across daemon restarts.
- **Tools:** Shell execution, file read/write/edit, browser automation (Playwright/CDP), an embedded terminal, and `codemode` (sandboxed JS tool chaining).
- **Subagents and crew:** Delegate tasks to isolated subagents or coordinate multiple sessions.
- **Cron and webhooks:** Scheduled jobs (`cron`) and inbound/outbound HTTP webhooks.
- **Memory and skills:** Long-term facts and notes in `memory.db`, plus reusable `SKILL.md` instruction packages.
- **Steward:** Analyzes session history to suggest skills, memories, and rules, and tidies open sessions.
- **Mail:** Read, search, draft, and organize Gmail threads.
- **MCP:** Connect external Model Context Protocol servers.
- **Providers:** Anthropic, OpenAI, Google, OpenAI-compatible endpoints (local or proxy), and the Claude Code and opencode CLIs as harnesses.

## Requirements and Quick Start

Requires [Bun](https://bun.sh/) (pinned to `1.4.4` in `package.json`). A Nix development shell is also available:

```bash
nix develop
```

Install dependencies, build the web UI, and start the daemon:

```bash
bun install
bun run build:web
bun run start
```

The daemon serves the API and web UI at `http://127.0.0.1:8787` by default.

Environment variables:

- `LUNA_DATA`: Data directory (default `~/.luna`).
- `LUNA_CONFIG`: Path to config file (default `~/.luna/luna.config.json`).
- `LUNA_HOST`: Bind address (default `127.0.0.1`).
- `LUNA_PORT`: Listen port (default `8787`).
- `LUNA_TOKEN`: Bearer token for API authentication.

## Configuration

See [CONFIGURATION.md](CONFIGURATION.md) for all options and [luna.config.example.json](luna.config.example.json) for a starter file.

To set the agent's identity, create `SOUL.md` inside your data directory (`~/.luna/SOUL.md` by default).

## Security

Luna can run shell commands on your host and connected workers, drive a local browser, and use stored provider credentials. Keep `LUNA_HOST` on loopback (`127.0.0.1`), or set `LUNA_TOKEN` in the environment before binding to a network interface. See [SECURITY.md](SECURITY.md) for the full threat model and vulnerability reporting.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for architecture and contribution rules.

Run checks locally before opening a PR:

```bash
bun run typecheck
bun run typecheck:web
bun test test/
```

## License

Licensed under the [Apache-2.0 License](LICENSE). Third-party notices are listed in [NOTICE](NOTICE).
