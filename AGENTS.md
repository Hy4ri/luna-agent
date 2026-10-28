# AGENTS.md

Operational and architectural instructions for AI coding agents working on `luna-pi`.

This document complements [`CONFIGURATION.md`](CONFIGURATION.md) (user settings, tools, and HTTP API reference) and [`luna.config.example.json`](luna.config.example.json) (example runtime configuration). Read the relevant implementation files and the contracts below before changing runtime wiring, configuration schemas, tool interfaces, or UI state. Flag contradictions between requirements and code instead of guessing.

---

## Project Overview & Tech Stack

`luna-pi` is a durable AI agent daemon, CLI, and web UI built on `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and `@earendil-works/chord`.

- **Runtime & Backend:** Node.js 26 (uses built-in `node:sqlite`), TypeScript 7 (`tsc -p .`), Hono (`@hono/node-server`) for REST and SSE streaming.
- **Schemas & Validation:** Zod v4 (`src/config.ts`) for strict configuration validation; TypeBox (`typebox`) for agent tool parameter schemas.
- **Protocols & Integrations:** `@modelcontextprotocol/sdk` (stdio, Streamable HTTP, and SSE MCP transports), `@anthropic-ai/claude-agent-sdk` (`claude-cli` / `claude-native`), `sharp` (image processing).
- **Web Frontend (`web/`):** Vue 3 (`<script setup lang="ts">`), Vite 8, Tailwind CSS v4, Reka UI, Lucide icons. Compiled assets output to `dist/web/`.
- **Package Manager & Toolchain:** `pnpm@12.11.2` enforced via `devEngines` in `package.json`. A Nix development shell (`flake.nix`) provides Node 26, `pnpm`, and `sqlite`.

See [`CONFIGURATION.md`](CONFIGURATION.md) for all configuration fields, built-in extensions, tool contracts, and HTTP endpoints.

---

## Commands & Verification Gates

### Package Manager Discipline

- **Do NOT use `npx`.** `package.json` enforces `pnpm` via `devEngines.packageManager`.
- Run scripts with `pnpm run <script>` or execute binaries directly from `./node_modules/.bin/<tool>` (or inside Nix via `nix develop -c pnpm ...`).

### Build & Typecheck Commands

```bash
pnpm run typecheck          # Backend TypeScript check (tsc -p ., TS 7)
pnpm run typecheck:web      # Frontend Vue SFC + TypeScript check (vue-tsc via TS 5 API)
pnpm run build:web          # Build web/ frontend into dist/web/
pnpm run start              # Start the HTTP/SSE daemon (src/daemon.ts)
pnpm run chat               # Run the interactive CLI client (src/cli.ts)
```

### Verification

This repo has **no tests**. Do not write, add, or restore test files, `verify-*.ts` scripts, fixtures, or test harnesses. Check changes with the TypeScript compiler only:

```bash
pnpm run typecheck          # Backend (tsc -p .)
pnpm run typecheck:web      # Frontend, when web/ changed
pnpm run build:web          # Frontend build, when web/ changed
```

### Verification Rules for Changes

1. **Before opening a PR:** Run `pnpm run typecheck`, plus `pnpm run typecheck:web` and `pnpm run build:web` if `web/` changed.
2. **No tests:** Do not add regression tests for features or bug fixes. Do not add `test` or `verify*` scripts to `package.json`.
3. **Exit codes:** Run checks unpiped so nonzero exit codes are preserved. Never report a timed-out or nonzero command as passing.

---

## Repository Layout

```text
luna-pi/
├── CONFIGURATION.md            # Canonical documentation for config, tools, and HTTP routes
├── luna.config.example.json    # Example runtime configuration
├── flake.nix                   # Nix devShell (nodejs_26, pnpm, sqlite)
├── pnpm-workspace.yaml         # allowBuilds allowlist and patchedDependencies
├── patches/                    # pnpm patches for @earendil-works/pi-ai and pi-durable
├── src/
│   ├── daemon.ts               # Process entrypoint: loads config, enforces auth, starts server
│   ├── runtime.ts              # Central wiring: builds models, MCP, extensions, harness, schedulers
│   ├── luna.ts                 # openLuna() wrapper around pi-durable harness + coding/memory/skills
│   ├── server.ts               # Hono HTTP/SSE API routes and static web asset serving
│   ├── config.ts               # Strict Zod ConfigSchema and path/env resolution
│   ├── settings.ts             # SettingsStore: live config reading, validation, and atomic writes
│   ├── cli.ts                  # Interactive terminal client against the daemon HTTP/SSE API
│   ├── providers.ts            # Built-in + custom model providers, auth.json store, catalog refresh
│   ├── claude-cli.ts           # Claude CLI provider adapter
│   ├── opencode-cli.ts         # OpenCode CLI provider adapter (free models; Luna tools via loopback MCP)
│   ├── claude-native/          # Native Claude transport, history budgeting, and admission control
│   ├── mcp.ts                  # McpManager: stdio/HTTP/SSE lifecycle and <dataDir>/mcp.json
│   ├── scheduler.ts            # CronStore (SQLite) and Scheduler loop
│   ├── cron-tools.ts           # Agent cron tools and ntfy-compatible run delivery
│   ├── delegate.ts             # Subagent spawning, forking, steering, and ownership checks
│   ├── session-crew.ts         # session_crew: lead full top-level sessions, automatic member reports
│   ├── session-create.ts       # Shared new-session rules (project, machine, model, thinking level)
│   ├── conversations.ts        # Conversation metadata, project association, and pinning
│   ├── projects.ts             # Project definitions and workspace routing
│   ├── board.ts                # Project kanban board extension and store
│   ├── todo.ts                 # Per-session task list extension
│   ├── goal.ts                 # Persistent conversation goal and completion audit loop
│   ├── memory.ts               # Durable facts/notes SQLite store and prompt budgeter
│   ├── recall.ts               # Full-text search index (FTS5) across past conversations
│   ├── skills.ts               # Skill catalog loader and SKILL.md parser
│   ├── skill-manage.ts         # Managed skill CRUD, linting, and trash/restore
│   ├── improve.ts              # Failure lesson extraction and benchmark-gated skill_propose
│   ├── learn.ts                # Idle session scanning and lesson diagnosis
│   ├── learn-command.ts        # /learn slash command handler
│   ├── vision.ts               # vision_analyze tool and native/auxiliary image routing
│   ├── image-gen.ts            # image_generate tool and provider manager
│   ├── plugins/image_gen/      # Image generation provider adapters (e.g. openai-codex)
│   ├── web-tools.ts            # Native web_search and web_extract tools + ddgs-web-provider.ts
│   ├── browser-tools.ts        # Native browser_* tools + camofox-browser-provider.ts
│   ├── busy-input.ts           # Interrupt / queue / steer policies for active turns
│   ├── busy-tools.ts           # Background process tools (process_start, process_manage)
│   ├── side-commands.ts        # Ephemeral side questions (/btw) without polluting main context
│   └── limit-continue.ts       # Automatic turn continuation after rate/quota reset
└── web/
    ├── vite.config.ts          # Vite 8 config + TS 5 SFC registration + service worker emitter
    ├── tsconfig.json           # Frontend TypeScript configuration
    ├── sw.ts                   # Service worker source
    └── src/
        ├── App.vue             # Root application shell
        ├── pages/              # Full-page views (SettingsPage, CronPage, AnalyticsPage)
        ├── components/         # UI components (chat/, composer/, panels/, sidebar/, ui/)
        ├── stores/             # Reactive state stores (app, chat, composer, models, sessions)
        └── lib/                # API client, SSE sync, markdown, tool renderers, DOM helpers
```

---

## Architecture & Runtime Contracts

### 1. Three-Layer Shipping Requirement
A capability is complete only when all three layers are verified:
1. **Module layer:** The module exists and typechecks.
2. **Runtime layer:** `src/runtime.ts` and `src/server.ts` install and wire the module into the real daemon entrypoint. A module that nothing in the daemon imports is dead code.
3. **User/Agent layer:** The agent can invoke the tool (or the user can operate the UI control) and receive the delivered result end-to-end.

### 2. Single Strictly Validated Configuration (`src/config.ts`)
- `ConfigSchema` uses `z.strictObject` across every nested object. Unknown keys, unknown extension names (`BUILTIN_EXTENSIONS`), duplicate provider IDs, and duplicate MCP server names fail validation immediately.
- Never silently ignore invalid configuration fields.

### 3. Settings Synchronization (`src/settings.ts`)
- Runtime configuration edits go through `SettingsStore`, which validates against `ConfigSchema` and writes atomically to `luna.config.json`.
- Web UI panels (Settings, Model Providers, MCP Servers) must read and update this shared store so live runtime policy (`busyInput`, `autoContinue`, `subagents`, `auxiliary`, etc.) stays consistent without requiring separate config files.

### 4. Data Directory Isolation (`dataDir`)
- All persistent runtime state (`luna.db`, `memory.db`, `cron.db`, `learn.db`, `recall.db`, `auth.json`, `mcp.json`, `skills/`, `processes/`, `uploads/`, `generated/`; legacy `generated-images/`) must live under `cfg.dataDir` (default `~/.luna`).
- Never hardcode database or state file paths relative to `process.cwd()` or the repository root.
- In verification scripts, always create an isolated temporary directory (`mkdtempSync`) for `dataDir` and clean it up on exit.

### 5. Prompt Caching & Token Budgets
- `pi-durable` sends a stable per-conversation `sessionId` and re-sends system prompt sections only when their content changes.
- **Keep system sections deterministic:** Never inject per-turn timestamps, random IDs, or unstable sort orders into always-on system sections (`identity`, `memory`, `skills`, `board`).
- **Enforce strict character caps:** Always-on prompt sections (`SOUL.md`, `USER.md`, `MEMORY.md` at 4000 chars each in `src/runtime.ts`; memory digest at 3000 chars in `src/memory.ts`; skill descriptions at <=300 chars in `src/skills.ts`) must truncate excess text and append a clear `[truncated: ...]` marker pointing to the full source.
- **Defer MCP schemas:** MCP tools default to `defer: true` (`src/mcp.ts`) and are discovered on demand via `tool_search`. Keep this default so every model call does not carry every MCP tool schema.
- **Compaction ownership:** Context compaction is executed by `pi-durable` with stock defaults; Luna sets no compaction policy. Check whether a context behavior lives in `pi-durable` or `luna-pi` before modifying code.

### 6. Security & Process Isolation
- **Network binding:** Binding `server.host` to any non-loopback address (`0.0.0.0`, LAN IP) requires `LUNA_TOKEN` in the environment. `src/daemon.ts` refuses to start otherwise.
- **Secrets handling:** API tokens and provider credentials belong in environment variables or `<dataDir>/auth.json` (mode `0600`). HTTP API responses (such as `/v1/mcp` or `/v1/providers`) must expose secret key names/status only, never secret values.
- **MCP child environment:** Stdio MCP servers must receive `getDefaultEnvironment()` merged with their explicitly configured `env` map—never raw `process.env` (which would leak `LUNA_TOKEN` and provider API keys).
- **Gated execution:** Background shell processes (`processes.enabled`) and shell command skill benchmarks (`improve.allowCommandBenchmarks`) are disabled by default and must remain config-gated.
- **External notifications:** When sending process or ask notifications to `cron.notifyUrl`, send status summaries only; never leak raw shell stdout/stderr into external push notifications.

---

## Frontend Conventions & Pitfalls to Avoid

### UI Design Rules
- **Minimal, state-honest UI:** Every control, badge, or chip must reflect real backend state. Avoid decorative clutter, fake toggles, or no-op controls.
- **No emojis in application UI:** Use Lucide icons (`@lucide/vue`) for visual indicators instead of emoji characters.
- **Shared state on reopen:** Modals, pickers, and drawers that remain mounted must refresh their data on open, not only on initial mount.
- **Accessible DOM structure:** Keep remove/pin actions as sibling buttons rather than nesting `<button>` inside `<button>`, and ensure unavailable items remain removable.

### Technical Pitfalls

1. **Never use unconditional `crypto.randomUUID()` in `web/`:**
   Browsers restrict `crypto.randomUUID()` to Secure Contexts (`https://` or `localhost`). When accessing the web UI over plain HTTP on a LAN IP (e.g. `http://192.168.1.x:8787`), `crypto.randomUUID()` throws `TypeError` and breaks interactions. Always provide a fallback using `crypto.getRandomValues()` or timestamp/random hex.
2. **Rebuild `web/` after changing it:**
   The daemon serves compiled assets from `dist/web/`. Always run `pnpm run build:web` after modifying files in `web/`.
3. **Read installed `pi-durable` and `pi-ai` declarations first:**
   Before writing extensions or tools, inspect the exact TypeScript definitions in `node_modules/@earendil-works/pi-durable/dist/` (`types.d.ts`, `harness/types.d.ts`, `harness/events.d.ts`) and `node_modules/@earendil-works/pi-ai/dist/`. Do not invent event shapes or method signatures.
4. **Updating `patches/*.patch`:**
   Dependency patches are managed in `patches/` and declared in `pnpm-workspace.yaml`. Never hand-edit hunk headers or line counts in `.patch` files; generate diffs cleanly and verify with `git apply --check --reverse`.
5. **Single-turn CLI adapters (`src/claude-cli.ts`, `src/claude-native/`):**
   Never serialize unbounded conversation history (`JSON.stringify(history)`) into a one-shot prompt string. Doing so defeats prompt caching and causes massive token write churn. Always use the bounded history/windowing helpers.

---

## Git & Pull Request Workflow

### PR-Always Targeting `main`
Every change must go through a branch and Pull Request targeting `main`. Never push directly to `main`, and never merge a PR without explicit approval.

```bash
git checkout main && git pull origin main
git checkout -b feat/short-description      # or fix/..., refactor/..., docs/..., test/..., chore/...
# implement changes and run the checks:
pnpm run typecheck
pnpm run typecheck:web
pnpm run build:web
git commit -m "feat(scope): concise summary"
git push -u origin HEAD
gh pr create --base main --title "feat(scope): concise summary" --body "..."
```

### Commit & Authorship Rules
- **Git identity:** Use the repository's configured Git user/author. Never override `--author` with an agent identity, and never add `Co-Authored-By:` or `Generated with` trailers.
- **Conventional Commits:** Prefix commit titles with `feat`, `fix`, `refactor`, `docs`, `test`, `ci`, or `chore` (optionally scoped, e.g. `feat(web): ...`, `fix(cron): ...`). Keep commit messages concise and atomic.
- **Preserve dirty worktree files:** If the working tree has unrelated uncommitted modifications, leave them untouched or work in an isolated `git worktree`.

### Documentation Synchronization
- Any change that adds, renames, or alters a configuration field in `src/config.ts`, an HTTP endpoint in `src/server.ts`, or an agent tool schema must update [`CONFIGURATION.md`](CONFIGURATION.md) and [`luna.config.example.json`](luna.config.example.json) in the same commit or PR.
