# User settings

Luna reads `luna.config.json` from its launch directory. Set `LUNA_CONFIG` to use another file.
An explicit path must exist. Without an explicit path, startup creates the default file if necessary.
Use `luna.config.example.json` as an example.

Open **Settings** in the Web UI to edit the same file. Every config field has a form control.
Main and subagent thinking selectors are independent. Subagents can also inherit the parent thinking level.
Other fields are grouped into expandable sections. Provider models, MCP arguments, environment variables,
headers, and skill directories have add/remove controls. No JSON editing is required.
Click **Save settings** to write changes. **Reload** discards unsaved edits and reads the file again.
The Providers and MCP panels also write this file, not separate settings files.

## Fields

- `provider`, `model`: default model for new sessions and cron runs.
- `thinkingLevel`, `instructions`: defaults for new chat sessions.
- `providers`: custom AI endpoints, API formats, and model definitions. Built-in providers need no entry.
- `subagents`: optional `provider`, `model`, `thinkingLevel`, and `cwd` overrides.
  Set both provider and model, or omit both to inherit the parent model.
  Normal and forked children use these defaults. Children cannot delegate further.
- `mcpServers`: stdio, HTTP, or SSE connections. `enabled: false` prevents connection.
  `defer` defaults to true. `timeoutMs` sets the tool-call timeout; the default is 600000 ms.
- `dataDir`, `cwd`, `extensions`, `skillDirs`, `cron`, `improve`, `server`: runtime settings.

Relative paths use the config file's directory. `~` expands to the user's home directory.

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

The `claude-cli` provider uses the installed Claude Code login. It requires **Python 3.10+**
and a recent official Claude Code CLI. It does not require Python packages or a Hermes installation.
`LUNA_CLAUDE_EXECUTABLE` selects the Claude executable; the default is `~/.local/bin/claude`.
`LUNA_CLAUDE_PYTHON` selects Python; the default is `python3`.
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

### Input budget

The adapter also rejects oversized input **before starting Claude**.
The default budget is **131072 bytes (128 KiB)**. It counts the UTF-8 JSON transport bytes of
structured history, native replay data, conversation instructions, and exported tool schemas.
This transport-size guard is not a token count. Claude's internal prompt overhead is additional.
It does not replace the runtime's context-window compaction.

Set `LUNA_CLAUDE_MAX_PROMPT_BYTES` in the daemon environment to change this budget.
The value must be a positive safe integer. Invalid values block CLI requests.
Increase it explicitly for larger histories. Restart the daemon after changing its environment.

When input exceeds the budget, Luna reports its size and limit without invoking Claude.
Compact the session using another provider, or start a new session, before retrying.
Large instructions or tool schemas can also require reduction.
The adapter never silently drops history or host tool results.

### Offline verification

`pnpm run verify:claude-cli:budget` checks the provider without inference.
`pnpm run verify:claude-cli:native` checks conversion, process handling, and local HTTP admission.
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

The test uses isolated config files, databases, and a faux model. It does not call an external AI provider.
