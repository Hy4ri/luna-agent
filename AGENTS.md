# AGENTS.md

Operational and architectural instructions for AI coding agents working on `luna-pi`.

This document complements [`CONFIGURATION.md`](CONFIGURATION.md) (user settings, tools, and HTTP API reference) and [`luna.config.example.json`](luna.config.example.json) (example runtime configuration). Read the relevant implementation files and the contracts below before changing runtime wiring, configuration schemas, tool interfaces, or UI state. Flag contradictions between requirements and code instead of guessing.

---

## Project Overview & Tech Stack

`luna-pi` is a durable AI agent daemon, CLI, and web UI built on `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and `@earendil-works/chord`.

- **Runtime & Backend:** Bun 1.4+ (uses built-in `bun:sqlite`, `Bun.serve`, and `Bun.Terminal`), TypeScript 7 (`tsc -p .`), Hono for REST and SSE streaming.
- **Schemas & Validation:** Zod v4 (`src/config.ts`) for strict configuration validation; TypeBox (`typebox`) for agent tool parameter schemas.
- **Protocols & Integrations:** `@modelcontextprotocol/sdk` (stdio, Streamable HTTP, and SSE MCP transports), `@anthropic-ai/claude-agent-sdk` (`claude-cli` / `claude-native`), `sharp` (image processing).
- **Web Frontend (`web/`):** Vue 3 (`<script setup lang="ts">`), Vite 8, Tailwind CSS v4, Reka UI, Lucide icons. Compiled assets output to `dist/web/`.
- **Package Manager & Toolchain:** `bun@1.4.4` enforced via `devEngines` in `package.json`. A Nix development shell (`flake.nix`) provides `bun` and `sqlite`.

See [`CONFIGURATION.md`](CONFIGURATION.md) for all configuration fields, built-in extensions, tool contracts, and HTTP endpoints.

---

## Commands & Verification Gates

### Package Manager Discipline

- **Do NOT use `npx` or `pnpm`.** `package.json` enforces `bun` via `devEngines.packageManager`.
- Run scripts with `bun run <script>` or execute binaries directly from `./node_modules/.bin/<tool>` (or inside Nix via `nix develop -c bun ...`).

### Build & Typecheck Commands

```bash
bun run typecheck           # Backend TypeScript check (tsc -p ., TS 7)
bun run typecheck:web       # Frontend Vue SFC + TypeScript check (vue-tsc via TS 5 API)
bun run build:web           # Build web/ frontend into dist/web/
bun run start               # Start the HTTP/SSE daemon (src/daemon.ts)
bun run chat                # Run the interactive CLI client (src/cli.ts)
```

### Verification

```bash
bun run typecheck           # Backend (tsc -p .), includes test/
bun test                    # Unit tests (bun:test), offline, no keys
bun run typecheck:web       # Frontend, when web/ changed
bun run build:web           # Frontend build, when web/ changed
```

The Nix dev shell includes Vim for the interactive terminal test. Run the suite inside it with `nix develop -c bun test`.
For the optional real-browser contracts, set `LUNA_TEST_CHROMIUM` to an installed Chromium-family executable (for example, `LUNA_TEST_CHROMIUM="$(command -v chromium)" bun test`). The browser fixtures use temporary profiles, not the user's browser profile. Without an override they look for `/usr/bin/chromium` and skip if it is absent.

### Verification Rules for Changes

1. **Before opening a PR:** Run `bun run typecheck` and `bun test`, plus `bun run typecheck:web` and `bun run build:web` if `web/` changed.
2. **Exit codes:** Run checks unpiped so nonzero exit codes are preserved. Never report a timed-out or nonzero command as passing.

---

## Testing

The suite is small on purpose. An earlier suite of about 95 per-feature `verify-*.ts` scripts (14k lines) was deleted because it cost more than it caught. Do not rebuild it.

### A test must pay for its upkeep

Before adding a test, answer three questions. If any answer is missing, do not add the test.

1. Which observable contract does it protect?
2. Which credible regression makes it fail?
3. Why does no existing test already catch that regression?

### What gets tested

- **Pure logic with a bug history:** prompt-cache transforms and history (`src/claude-native/`), limit classification (`src/limit-reset.ts`), cron schedules (`src/cron-expr.ts`), request projections (`src/tool-visibility.ts`), media directives.
- **Security invariants:** confined reads, credential paths, MCP child environment, non-loopback bind without `LUNA_TOKEN`, strict config validation.
- **Durable stores:** one round trip per SQLite store, only when the store has logic beyond plain SQL.

A bug fix in these areas must add a regression test that **fails on the code before the fix**. Features, UI changes, and runtime wiring do not need a test; prove them with the three-layer check.

### What does not get tested

- Live providers, live CLIs (`claude`, `opencode`), or anything that needs a network or a real credential.
- Browser, Playwright, or UI smoke tests. Vue component snapshots.
- Behavior owned by a dependency (`pi-durable`, `pi-ai`, Zod, Hono), or config that only passes values through.
- Source text (import or string greps), unless the text itself is the contract, such as a persisted key.

### Rules

- **Location:** tests live only in `test/*.test.ts` and use `bun:test` with `node:assert/strict`. Adding a test dependency needs approval.
- **One contract, one owner:** test each behavior once, at the strongest boundary that observes it. Extend an existing table or file before creating a new file.
- **A test must be able to fail:** do not assert values the code under test produced, do not mock the behavior you assert, and always `await` `assert.rejects`.
- **Test the real implementation:** call exported functions. Do not copy production logic into a test. Avoid mocks; never patch globals unless no other option exists.
- **No test-only seams:** do not add exports, parameters, flags, or globals to production code only for tests. A clock parameter that production code already uses (for example `classifyLimit(message, now)`) is fine.
- **Fixtures are recordings:** inputs captured from real providers or retired implementations go in `test/fixtures/` as JSON. Never edit a recording by hand to make a test pass; re-capture it and say why in the PR.
- **Isolation:** create every `dataDir` or working directory with `mkdtempSync` and remove it in `after`. Close databases and servers before removal. Restore every changed environment variable. Bind servers to `127.0.0.1` port `0`.
- **Time:** pass the clock or advance mock timers. Never sleep to wait for a state, and never assert wall-clock speed. Poll real events only with a deadline in milliseconds.
- **Known bugs:** a confirmed, unfixed bug may keep its failing test with `{ todo: "bug: <summary or issue link>" }`. The fix PR removes `todo`. Never use `todo` or `skip` to hide a test that passes or fails at random.
- **Flakes:** fix a flaky test or delete it. Never absorb it with a longer timeout, a retry, or a skip.
- **Budget:** the whole suite runs in seconds. A single test that takes more than about one second does real work you can name; remove that work or justify it in the PR.
- **Moving coverage:** when you delete or move a test, name the test that still proves the contract.

---

## Repository Layout

```text
luna-pi/
├── CONFIGURATION.md            # Canonical documentation for config, tools, and HTTP routes
├── luna.config.example.json    # Example runtime configuration
├── flake.nix                   # Nix devShell (bun, sqlite)
├── bunfig.toml                 # Bun package manager settings (minimumReleaseAge)
├── patches/                    # Bun patches for @earendil-works/pi-ai and pi-durable
├── test/                       # bun:test unit tests (*.test.ts), recorded fixtures/, helper processes in support/
├── src/
│   ├── daemon.ts               # Process entrypoint: loads config, enforces auth, starts server
│   ├── runtime.ts              # Central wiring: builds models, MCP, extensions, harness, schedulers
│   ├── luna.ts                 # openLuna() wrapper around pi-durable harness + coding/memory/skills
│   ├── server.ts               # Hono HTTP/SSE API routes and static web asset serving
│   ├── routes/                 # Route handler modules registered by server.ts
│   ├── terminal/               # Terminals: Bun.Terminal PTY host, session-owned registry with shared control, headless VT screen, Luna's terminal tool, attach tickets and WebSocket
│   ├── config.ts               # Strict Zod ConfigSchema and path/env resolution
│   ├── settings.ts             # SettingsStore: live config reading, validation, and atomic writes
│   ├── cli.ts                  # Interactive terminal client against the daemon HTTP/SSE API
│   ├── providers.ts            # Built-in + custom model providers, auth.json store, catalog refresh
│   ├── claude-cli.ts           # Claude CLI provider adapter
│   ├── opencode-cli.ts         # OpenCode CLI provider adapter (free models; Luna tools via loopback MCP)
│   ├── claude-native/          # Native Claude transport, history budgeting, and admission control
│   ├── mcp.ts                  # McpManager: stdio/HTTP/SSE lifecycle, <dataDir>/mcp.json, provider-backend hiding
│   ├── scheduler.ts            # CronStore (SQLite) and Scheduler loop
│   ├── cron-tools.ts           # Agent cron tool (jobs, runs, lessons) and ntfy-compatible run delivery
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
│   ├── improve.ts              # Benchmark-gated skill proposals (SkillImprover)
│   ├── wife/                   # Wife tab: store, detectors, learning loop, policy, service, `wife` tool
│   ├── learn-command.ts        # /learn slash command handler
│   ├── media.ts                # media_analyze tool: routes images to vision.ts, videos to video.ts
│   ├── vision.ts               # Native/auxiliary image analysis for media_analyze
│   ├── image-gen.ts            # image_generate tool and provider manager
│   ├── plugins/image_gen/      # Image generation provider adapters (e.g. openai-codex)
│   ├── web-tools.ts            # Native `web` tool (search, read) + ddgs-web-provider.ts
│   ├── browser-tools.ts        # Native browser_* tools + camofox/moli/chromium providers
│   ├── busy-input.ts           # Interrupt / queue / steer policies for active turns
│   ├── busy-tools.ts           # bash background flag and the process_manage tool
│   ├── side-commands.ts        # Ephemeral side questions (/btw) without polluting main context
│   ├── scheduled-messages.ts   # Durable same-chat scheduled inputs and cancellation
│   ├── limit-recovery.ts       # One-shot recovery through the shared scheduler
│   └── limit-continue.ts       # Migration-only reader for retired limit waits
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
- All persistent runtime state (`luna.db`, `memory.db`, `cron.db`, `wife.db`, `recall.db`, `auth.json`, `mcp.json`, `skills/`, `processes/`, `uploads/`, `generated/`; legacy `generated-images/`) must live under `cfg.dataDir` (default `~/.luna`).
- Never hardcode database or state file paths relative to `process.cwd()` or the repository root.
- In tests, always create an isolated temporary directory (`mkdtempSync`) for `dataDir` and clean it up on exit.

### 5. Prompt Caching & Token Budgets
- `pi-durable` sends a stable per-conversation `sessionId` and re-sends system prompt sections only when their content changes.
- **Keep system sections deterministic:** Never inject per-turn timestamps, random IDs, or unstable sort orders into always-on system sections (`identity`, `memory`, `skills`, `board`).
- **Enforce strict character caps:** Always-on prompt sections (`SOUL.md` at 4000 chars in `src/runtime.ts`; memory section at 8000 chars in `src/memory.ts`) must truncate excess text and append a clear `[truncated: ...]` marker pointing to the full source. Skill descriptions are shown in every prompt; the skill lint in `src/improve.ts` rejects descriptions over 300 chars.
- **Defer MCP schemas:** MCP tools default to `defer: true` (`src/mcp.ts`) and are discovered on demand via `tool_search`. Keep this default so every model call does not carry every MCP tool schema. The `deferred-tools` prompt section (`src/deferred-tools.ts`) names every deferred tool, so the model knows what `tool_search` can load. Tool parameters with fixed values use `StringEnum` (`src/string-enum.ts`), not a union of literals: a union reports only its first value when a model sends a near miss.
- **Compaction ownership:** `pi-durable` executes compaction natively. Luna translates `compaction.sessions` and `compaction.subagents` into native per-model `modelOverrides` (`src/compaction-limits.ts`); there is no compaction patch. Check both layers before changing context behavior.

### 6. Security & Process Isolation
- **Network binding:** Binding `server.host` to any non-loopback address (`0.0.0.0`, LAN IP) requires `LUNA_TOKEN` in the environment. `src/daemon.ts` refuses to start otherwise.
- **Secrets handling:** API tokens and provider credentials belong in environment variables or `<dataDir>/auth.json` (mode `0600`). HTTP API responses (such as `/v1/mcp` or `/v1/providers`) must expose secret key names/status only, never secret values.
- **MCP child environment:** Stdio MCP servers receive `getDefaultEnvironment()` merged with their configured `env` map, never raw `process.env` (which would leak `LUNA_TOKEN` and provider keys).
- **Agent terminal:** `terminal.agent` is off by default and read live. The `terminal` tool is deferred and must stay a last resort: its description and errors send ordinary commands to `bash`/`process`, and `start` refuses a bare shell. The backend loader in `src/terminal/vt-model.ts` verifies the vendored official libghostty-vt WASM checksum. The browser uses the same ABI core through `web/src/lib/term-adapter.ts`; keep the WASM version and loader checksum aligned.
- **User terminals:** `terminal.user` is off by default and read live. The shell environment must never contain `LUNA_TOKEN` or `LUNA_WORKER_TOKEN`. The attach WebSocket takes a single-use ticket, never the Bearer token in a URL.
- **Gated execution:** Background shell processes (`processes.enabled`) and shell command skill benchmarks (`improve.allowCommandBenchmarks`) are disabled by default and must remain config-gated.
- **External notifications:** When sending process or ask notifications to `cron.notifyUrl`, send status summaries only; never leak raw shell stdout/stderr into external push notifications.

---

## Frontend Conventions & Pitfalls to Avoid

### UI Design Rules
- **Minimal, state-honest UI:** Every control, badge, or chip must reflect real backend state. Avoid decorative clutter, fake toggles, or no-op controls.
- **No emojis in application UI:** Use Lucide icons (`@lucide/vue`) for visual indicators instead of emoji characters.
- **Shared state on reopen:** Modals, pickers, and drawers that stay mounted must refresh data when opened, not just on initial mount.
- **Accessible DOM structure:** Keep remove/pin actions as sibling buttons rather than nesting `<button>` inside `<button>`, and ensure unavailable items remain removable.

### Technical Pitfalls

1. **Never use unconditional `crypto.randomUUID()` in `web/`:**
   Browsers restrict `crypto.randomUUID()` to Secure Contexts (`https://` or `localhost`). When accessing the web UI over plain HTTP on a LAN IP (e.g. `http://192.168.1.x:8787`), `crypto.randomUUID()` throws `TypeError` and breaks interactions. Always provide a fallback using `crypto.getRandomValues()` or timestamp/random hex.
2. **Rebuild `web/` after changing it:**
   The daemon serves compiled assets from `dist/web/`. Always run `bun run build:web` after modifying files in `web/`.
3. **Read installed `pi-durable` and `pi-ai` declarations first:**
   Before writing extensions or tools, inspect the exact TypeScript definitions in `node_modules/@earendil-works/pi-durable/dist/` (`types.d.ts`, `harness/types.d.ts`, `harness/events.d.ts`) and `node_modules/@earendil-works/pi-ai/dist/`. Do not invent event shapes or method signatures.
4. **Updating `patches/*.patch`:**
   Dependency patches are managed in `patches/` and declared in `package.json` under `patchedDependencies`. Never hand-edit hunk headers or line counts in `.patch` files; generate diffs cleanly and verify with `git apply --check --reverse`.
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
bun run typecheck
bun test
bun run typecheck:web
bun run build:web
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
