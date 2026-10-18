# User settings

Luna reads `luna.config.json` from its launch directory. Set `LUNA_CONFIG` to use another file.
An explicit path must exist. Without an explicit path, startup creates the default file if necessary.
Use `luna.config.example.json` as an example.

Open **Settings** in the Web UI to edit the same file on a full page.
The page has five tabs:

- **General:** data directory, working directory, and HTTP server.
- **Models:** main model, subagent defaults, and custom model providers.
- **Context:** default instructions and automatic compaction.
- **Tools:** web providers, MCP connections, extensions, and extra skill directories.
- **Automation:** scheduled runs and self-improvement.

Every config field has a form control. All tabs share one unsaved draft.
Leaving with unsaved changes requires confirmation. Direct links such as `/#settings/tools` open a specific tab.
Main and subagent thinking selectors are independent. Subagents can inherit the parent thinking level.
Provider models, MCP arguments, environment variables, headers, and skill directories have add/remove controls.
No JSON editing is required.
Click **Save settings** to write changes. **Reload** discards unsaved edits and reads the file again.
The Providers and MCP panels also write this file, not separate settings files.

## Fields

- `provider`, `model`: default model for new sessions and cron runs.
- `thinkingLevel`, `instructions`: defaults for new chat sessions.
- `compaction`: automatic context compaction. `enabled` defaults to `true`.
  `triggerPercent` is an integer from 1 through 99; the default is `75`.
  Both controls are under **Settings → Context → Automatic compaction** and apply live to existing sessions.
  The trigger uses the selected model's context window, not lifetime token usage.
  Running tool calls finish first. The next model request waits for compaction, then resumes.
  A final answer can compact before the run settles, without starting another turn.
  Disabling automatic compaction leaves emergency context-overflow recovery enabled.
- `providers`: custom AI endpoints, API formats, and model definitions. Built-in providers need no entry.
- `subagents`: optional `provider`, `model`, `thinkingLevel`, and `cwd` overrides.
  Set both provider and model, or omit both to inherit the parent model.
  Normal and forked children use these defaults. Children cannot delegate further.
- `mcpServers`: stdio, HTTP, or SSE connections. `enabled: false` prevents connection.
  `defer` defaults to true. `timeoutMs` sets the tool-call timeout; the default is 600000 ms.
- `dataDir`, `cwd`, `extensions`, `skillDirs`, `cron`, `improve`, `server`: runtime settings.

Relative paths use the config file's directory. `~` expands to the user's home directory.

## Native web tools

The agent calls `web_search` and `web_extract`. Their names and parameters do not depend on the provider.

- `web_search`: `query` and optional positive integer `count` (default `5`).
  Returns `{"results":[{"title":"...","url":"...","snippet":"..."}]}`.
- `web_extract`: an HTTP(S) `url` and optional `format` (`markdown` or `text`; default `markdown`).
  Returns `{"url":"...","content":"...","format":"markdown"}`.

Web results are untrusted data, not instructions. Provider failures return tool errors, not empty successful results.
URLs with embedded credentials and non-HTTP(S) protocols are rejected.
These tools are native and do not require `tool_search` discovery.

Choose each operation's provider in **Settings → Tools → Web tools**.
Both operations default to `disabled`. DDGS is the only included provider.
The common tool interface accepts no DDGS options. The DDGS adapter translates requests and normalizes results.
A new adapter implements `WebProvider` and is registered by the runtime, with its own validated configuration.
The common tool implementation does not need to change.

DDGS reuses an existing managed MCP connection. Configure that connection under **Tools → MCP servers**.
Set the DDGS MCP server name to its exact configured name. The connection must be enabled and connected.
The host must already have DDGS with MCP support installed. This change does not install DDGS.
For example, use the following entries with the rest of your configuration:

```json
{
  "web": {
    "searchProvider": "ddgs",
    "extractProvider": "ddgs",
    "providers": {
      "ddgs": {
        "mcpServer": "ddgs",
        "backend": "auto",
        "region": "us-en",
        "safesearch": "moderate"
      }
    }
  },
  "mcpServers": [
    { "name": "ddgs", "transport": "stdio", "command": "ddgs", "args": ["mcp"] }
  ]
}
```

Use an absolute command path if DDGS is not on the daemon's PATH.
DDGS options remain under `web.providers.ddgs`. Its proxy credentials, if needed, remain in the protected MCP environment (`DDGS_PROXY`).
Connection timeouts use the existing MCP `timeoutMs`. Cancellation reaches the same managed connection.
Save and restart Luna to apply web provider selection or option changes.
A disabled or disconnected selection fails explicitly. There is no silent fallback to another provider.

Run `verify:web-tools` for deterministic runtime checks.
Run `verify:web-tools:live` to use the installed `/.local/bin/ddgs` against real web pages.
The live gate uses a scripted model; it verifies tool execution, not real-model tool choice.

## Applying changes

Model, thinking, instruction, and subagent defaults apply to new sessions or children.
Existing sessions retain their selected model and settings.
Provider and MCP panel operations apply live.
Other Settings form changes need a restart, including provider definitions and MCP connections.
The UI shows a restart notice. Provider and MCP mutations are blocked until that restart.
This prevents an old in-memory connection list from overwriting saved settings.

Environment variables still override the file: `LUNA_DATA`, `LUNA_CWD`, `LUNA_PROVIDER`,
`LUNA_MODEL`, `LUNA_HOST`, and `LUNA_PORT`. Settings lists active override names.

## Claude CLI provider

The `claude-cli` provider uses the installed Claude Code login. It requires a recent official
Claude Code CLI. The transport runs inside the daemon; it does not require Python or a Hermes installation.
`LUNA_CLAUDE_EXECUTABLE` selects the Claude executable; the default is `~/.local/bin/claude`.
Use `claude auth login`, `CLAUDE_CODE_OAUTH_TOKEN`, or `CLAUDE_CONFIG_DIR` for authentication.
Conflicting API keys, custom Anthropic endpoints, and Bedrock/Vertex/Foundry overrides block requests.
The provider does not silently change to API billing or another model.

Luna replays separate native user, assistant, tool-use, and tool-result frames.
It no longer embeds the conversation as a JSON string in one user prompt.
Signed native assistant blocks are retained for unchanged responses from this provider and model.
A request-scoped local relay permits at most one upstream Messages request.
The relay keeps cache markers on recurring content, not on Claude's per-request context.
This preserves reusable message prefixes; it does not guarantee vendor cache hits or quota savings.

Luna executes all tools. Claude receives an inert tool inventory and cannot execute Luna tools.
Luna supplies actual host results on the next request. Claude's temporary transcript is not resumed.
A tool-result mismatch blocks forwarding instead of accepting a synthetic denial.
Only a complete, validated response can return actionable tool calls.
Plain model IDs use a conservative 200000-token window. Explicit `[1m]` routes report 1000000 tokens.
The adapter has no input-size guard. The runtime's context-window compaction limits history size.

### Offline verification

`pnpm run verify:claude-cli:budget` checks the provider without inference.
`pnpm run verify:claude-cli:native` checks conversion, Python parity, process handling, and local HTTP admission.
To qualify the installed CLI against a synthetic local peer, run:

```sh
pnpm run verify:claude-cli:wire /absolute/path/to/claude
```

This wire check uses temporary configuration and fake credentials. It does not call Anthropic.
`verify:claude-cli:live` is separate and uses the real subscription; run it only when intended.

## Validation and credentials

Unknown keys, invalid values, duplicate names, and incomplete subagent model selections are rejected.
Writes use a temporary file and atomic rename, with file permissions `0600`.
A revision check rejects stale Web UI saves. Reload and reconcile your changes before retrying.

API keys and OAuth tokens remain in the protected credential store (`auth.json`).
`LUNA_TOKEN` remains an environment secret. Neither is returned by the settings API.
MCP environment values, headers, and URLs with query strings or credentials are hidden in Settings.
Keep the `<secret: unchanged>` marker to retain a saved value, or replace it to change the value.
Do not put secrets in instructions or command arguments.

## Migration

On first startup with the old config format (no `providers` field), Luna imports custom providers
and the UI default from `<dataDir>/providers.json`. The old UI default retains its former precedence.
It merges servers from `<dataDir>/mcp.json`; existing config entries win name conflicts.
The resulting config includes `providers`, so later starts do not repeat migration.
Old files remain unchanged as backups. Runtime credential storage is not moved.

Conversations, jobs, memory, and other application data remain in their databases.
They are not user configuration.

## Browser verification

Run `verify:settings-ui` with an installed Playwright and Chromium. For example:

```sh
LUNA_PLAYWRIGHT_PATH=/path/to/playwright pnpm run verify:settings-ui
```

Also run `verify:settings-page-ui` to check full-page navigation, tabs, drafts, deep links, mobile layout, and error recovery.
Both tests use isolated config files, databases, and a faux model. They do not call an external AI provider.

## Context usage

The chat context bar shows estimated active tokens, model capacity, and the percentage used.
It is green below 50%, amber from 50% up to the configured trigger, and red at or above the trigger.
A trigger below 50% takes precedence over green. Unknown model capacity is shown as unavailable.
The bar refreshes after tool results, model changes, and compaction. It is not a live tokenizer.
Older usage measurements are discarded after a summary changes the context boundary.
The separate token totals remain cumulative usage.

## Runtime compaction policy

The pinned `pi-durable` dependency has a local pnpm patch in `patches/`.
It adds blocking percentage thresholds, separate automatic and overflow switches, and a durable
final-answer checkpoint. `pnpm install --frozen-lockfile` applies this patch on a clean install.
Keep the patch when updating the dependency until the equivalent behavior exists upstream.
In percentage mode, recent history retention is capped at half the trigger budget (maximum 20,000 tokens).
This keeps compaction useful for small model windows. No running tool is interrupted.


## Messages sent during a turn

```json
"busyInput": { "mode": "interrupt", "acknowledgements": true }
```

Change these fields in **Settings → Busy chat input**. Both apply immediately, including to existing sessions.

- `interrupt` (default): redirect an active model request. Keep partial text and finished work. During tools, steer instead.
- `steer`: add text after the tool batch. Multiple pending steers form one user message, separated by newlines. Check again before ending a turn.
- `queue`: run each message as a separate later turn, in order. Do not combine message boundaries.

Images always queue. Text transcripts use the text policy. Interrupt mode falls back to queue during compression or active subagents.
Internal background and subagent completion messages always use follow-up input. They never redirect the model.

Override the default for one message:

- `/queue message`
- `/steer message`
- `/redirect correction`

Inspect or change the queue without calling the model:

- `/queue` or `/queue list`
- `/queue edit N replacement text`
- `/queue remove N`
- `/queue move A B` (also accepts `move A to B`)
- `/queue clear`

Queue numbers start at 1. Each command applies atomically to the current queue. Repeated request IDs do not repeat mutations.
`/stop` and the Stop button always hard-stop the current work and withdraw pending input. They do not become model messages.
`/model`, `/compress`, `/compact`, and `/retry` are rejected while busy. Use session controls when idle.
Input sent while a stop is draining receives a notice and HTTP 409. Send it again after the stop finishes.

Acknowledgements name the accepted action: queued, steered, or redirected. They are limited to one per session per 30 seconds.
Disable them with `acknowledgements: false`. A one-time tip explains each selected mode. Queue command responses are not acknowledgements.

A redirected foreground shell command yields its wait. The same OS process continues in the background, without restart.
The model receives its process ID and can use `process_manage` to list, read, wait for, or stop it. Handles belong to their chat session.
Completion returns as follow-up input. Arbitrary tools without a cooperative yield point finish normally; they are never killed by redirect.
Background OS processes are local to the daemon process. A normal daemon shutdown stops them; they are not restart-persistent tasks.

The HTTP message endpoint returns `action`, plus optional `notice` and `tip`. Existing `whenBusy: "steer" | "followUp" | "reject"` clients remain supported.
`whenBusy: "redirect"` requests a per-message redirect. Command responses include `command: true` and queue commands return numbered `queue` rows.
The web client omits `whenBusy` for normal sends, so the saved mode controls routing.


## Parallel chat commands

Both commands run immediately, including during a model call, tool execution, or compaction.
They do not interrupt, steer, or queue the main turn. They also work while a main-turn stop drains.

| Command | Context | Tools | Result |
| --- | --- | --- | --- |
| `/btw question` | Snapshot of this conversation | Denied | Short text answer |
| `/bg prompt` | Fresh conversation | Same enabled tools as the source | Full task result and media |

An empty argument returns usage. `/btw` reports unreadable history, empty history, or unavailable provider credentials before starting.
`/bg` can start from an empty chat. Include all necessary task context in its prompt.
Images go directly to the new conversation. Audio attachments become local files with paths in its prompt.
Audio understanding requires an enabled tool that can read or transcribe those files; it is not a native audio model input.
Ordinary messages cannot contain audio. `/btw` ignores attachments.

The started receipt includes the prompt preview and job ID. Results appear separately in the same chat.
They are not synthetic user or assistant entries in the main history. The main agent never sees them.
The web client restores job results after reconnecting, or after switching away and back, while the daemon remains running.
The CLI prints results with their job ID. Closing a viewer does not stop a job. The main Stop button does not stop side jobs.
There is no side-job steering or cancellation command.

`/btw` replays the unchanged structured prompt prefix when a complete assistant boundary exists.
It uses the source provider session identity and records its usage against the source session.
It trims unfinished tail messages. The snapshot can therefore omit recent activity.
The side instruction is a new user suffix, not a change to the main system prompt.
Tool calls receive denial results without dispatch, with at most three model calls total.
When structured replay is unavailable, it uses one plain-text call: 2,000 characters per message,
24,000 characters total, newest messages first for budget selection. System messages are omitted.
Actual provider cache hits depend on provider behavior; prefix parity is not proof of a cache hit.

Optional side-question routing uses a bounded plain-text digest instead of structured replay:

```json
"auxiliary": {
  "side_question": { "provider": "openai", "model": "gpt-4.1-mini" }
}
```

Both route fields are required. Settings changes apply to the next side question.
The route does not change `/bg` or the main model.

The new `/bg` conversation has its own durable numeric session ID and a `bg_HHMMSS_xxxxxx` job ID.
It inherits the source model, thinking level, instructions, working directory, and enabled extensions, but no transcript.
Its tool actions can change shared files and services. Isolation applies to chat history, not the operating system.
`MEDIA:` file directives in its answer provide authenticated image, audio, video, or document delivery.
The web client displays media in the answer where each directive occurs. The CLI prints download URLs.
Only files named in that job result are downloadable. File reads reject final symlinks and non-regular files.

Job receipts, result delivery, and attached audio files last for the current daemon process.
They are not a restart-safe job queue. Normal shutdown stops active side jobs and removes attached audio files.
The `/bg` transcript remains in its separate durable conversation.

HTTP clients use the normal message endpoint. Side commands return HTTP 202 with
`{ command: true, job, notice }`, without a main submission ID.
`GET /v1/sessions/:id/side-jobs` lists only that chat's jobs.
The session event stream sends `side_jobs` on connection and `side_job` for state changes.
Retries with the same request ID reuse the same job; conflicting reuse is rejected.
