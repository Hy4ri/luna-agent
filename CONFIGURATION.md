# User settings

Luna reads `luna.config.json` from its launch directory. Set `LUNA_CONFIG` to use another file.
An explicit path must exist. Without an explicit path, startup creates the default file if necessary.
Use `luna.config.example.json` as an example.

Open **Settings** in the Web UI to edit the same file on a full page.
The page has six tabs:

- **General:** data directory, working directory, HTTP server, and busy chat input.
- **Models:** main model, subagent defaults, custom model providers, and auxiliary models.
- **Context:** default instructions and automatic compaction.
- **Tools:** web and browser providers, background processes, MCP connections, extensions, and extra skill directories.
- **Automation:** scheduled runs, self-improvement, and session learning.
- **Workspace:** Subagents, Analytics, Memory, Skills, Model providers, and MCP servers.

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
- `autoContinue`: continue a turn automatically after a rate or usage limit resets. `enabled` defaults to `false`.
  Edit it under **Settings → Automation**. Changes apply live.
  When a top-level turn stops on a limit error, Luna reads the reset time from the error and waits until one minute after it.
  It understands epoch fields (`resets_at`), clock times with a zone ("resets 12:30am (Asia/Amman)"), durations
  ("try again in 6m0s", Google `retryDelay`), and ISO times. Without a time, it retries after 2, 10, 30, then 60 minutes.
  Short transient errors are first retried inside the turn by the runtime, as before.
  Context overflow, authentication, billing, and `insufficient_quota` errors never wait.
  `maxWaitHours` (default `168`) skips longer waits. `maxAttempts` (default `5`) stops continuations that hit a limit again.
  A new message or **Cancel** next to the resume time removes the wait. Waits survive a restart.
  Cron runs and subagents never continue automatically.
- `sessionTalk`: messages between sessions. `enabled` defaults to `true`; `maxHops` (1 through 20) defaults to `3`.
  Edit it under **Settings → Chat**. Changes apply live. See **Sessions talk with each other**.
- `providers`: custom AI endpoints, API formats, and model definitions. Built-in providers need no entry.
- `subagents`: optional `provider`, `model`, `thinkingLevel`, and `cwd` overrides.
  Set both provider and model, or omit both to inherit the parent model.
  Normal and forked children use these defaults. Children cannot delegate further.
- `mcpServers`: stdio, HTTP, or SSE connections. `enabled: false` prevents connection.
  `defer` defaults to true. `timeoutMs` sets the tool-call timeout; the default is 600000 ms.
- `dataDir`, `cwd`, `extensions`, `skillDirs`, `cron`, `improve`, `learn`, `server`: runtime settings.

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

## Skill management

The `skills` extension gives the agent `skill_view`, `skill_list`, and `skill_manage`.

- Only skills under `<dataDir>/skills` can change. Skills from `skillDirs` are read-only.
- `skill_manage` actions: `create`, `edit` (full content, or one exact `old_text` → `new_text`), `delete`,
  `write_file`, `delete_file` (linked files, relative to the skill directory), and `restore`.
- `create` and `edit` are linted only. Use `skill_propose` for a benchmark-gated change.
  Each edit backs up the previous `SKILL.md` for `skill_rollback`.
- `delete`, `delete_file`, and a replaced linked file move to `<dataDir>/skills/.history/.trash`.
  `skill_list include_deleted` shows the ids; `restore` never overwrites an existing path.
- Linked-file paths stay in the skill's own directory: no `..`, no hidden parts, no symlinks,
  no `SKILL.md`, and no path inside a nested skill. A skill that contains nested skills cannot be deleted.
- Changes reach the prompt catalog on the next model call.

## Session learning

The `learn` extension finds lessons in past sessions. It does nothing during a live turn.

1. **Detect.** After a conversation is idle for `learn.idleMinutes` (default `30`), a scan records signals:
   user corrections, explicit user rules, and failed tool calls. It skips subagent and cron conversations.
   A signal stores a redacted one-line summary and a pointer (session and message), not a transcript copy.
   A tool error that the same tool recovers from later in the session becomes a tool lesson immediately.
2. **Diagnose.** The daily `luna-learn` cron job (`learn.schedule`, default `0 4 * * *`) groups signals into lessons.
   Each lesson has a cause: `missing`, `not_loaded`, `ignored`, or `wrong`.
3. **Fix.** A lesson needs evidence from 2+ sessions or one explicit user rule. A skill proposal needs
   regression phrases (`must_contain`), passes a dry-run verification, and can grow the skill by at most 1500 characters.
   A `not_loaded` fix must change the skill description. An `ignored` rule is not rewritten; it is flagged for a code guard.
4. **Review.** The learning agent reviews its own proposals. It applies a routine fix at once (`lesson_propose`),
   with a backup. It drops noise lessons with `lesson_dismiss`, so they are never proposed again.
   A fix that removes or reverses a rule, or changes identity, safety, permission, publishing, money, or privacy behavior,
   is held with a `critical` reason. Only held fixes wait in **Settings → Automation → Lessons**, with the reason, a diff, and evidence.
   Approve applies a held fix, and Reject stops it from being proposed again. Roll back restores the backup of any applied skill change.
   The agent cannot apply or dismiss a held fix, and cannot dismiss an applied lesson.
5. **Measure.** A recurrence after apply marks the lesson `ineffective`; a second failure flags it for a code guard.
   Three later sessions that load the skill without a recurrence mark it `confirmed`.

Data lives in `<dataDir>/learn.db`. HTTP: `GET /v1/lessons`, `POST /v1/lessons/scan`, and
`POST /v1/lessons/:id/approve|reject|rollback` (`reject` takes an optional `note`). Each lesson has `critical`:
the hold reason, or `null`. Proposals that were pending before automatic review stay held for the user.

## Learning from a source

`/learn <source> [objective]` studies a web page, repository, or local file and saves what it learns as a skill.
Quote a source that contains spaces: `/learn "/docs/My Guide.pdf" the release steps`.
An empty argument returns usage.

The command becomes a normal turn in the current chat. It queues, steers, and stops like any other message.
The agent reads the source with its enabled tools (`web_extract`, browser, `read`, shell).
It then creates or updates one managed skill with `skill_manage`, which lints and backs up the previous version.
Use `skill_rollback` to undo an update. External skills stay read-only; the agent creates a managed skill instead.
The skill lists its sources and marks each point as verified or assumed.
Sending `/learn` authorizes this one skill write; there is no separate approval step.

Source content is untrusted data. The instruction tells the agent to ignore any instructions in it.
This is a prompt rule, not a sandbox: the agent keeps its normal tool permissions during the turn.
Requires the `skills` extension. `pnpm run verify:learn-command` checks it with a scripted model only.

## Native browser tools

The agent uses these provider-neutral tools without `tool_search` discovery:

| Tool | Parameters | Result |
| --- | --- | --- |
| `browser_open` | `url` | `tabId`, current `url` |
| `browser_navigate` | `tabId`, `url` | `tabId`, current `url` |
| `browser_close` | `tabId` | `tabId`, `closed: true` |
| `browser_snapshot` | `tabId`, optional `offset` | `tabId`, `url`, `content`, `hasMore`, optional `nextOffset` and `totalChars`; image when available |
| `browser_click` | `tabId`, exactly one `ref` or `selector` | `tabId`, `ok: true` |
| `browser_type` | `tabId`, exactly one `ref` or `selector`, `text`, optional `pressEnter` | `tabId`, `ok: true` |
| `browser_scroll` | `tabId`, `direction`, optional `amount` | `tabId`, `ok: true` |
| `browser_screenshot` | `tabId` | `tabId` and a viewport image block |

Open and navigate require HTTP(S) URLs without embedded credentials. Provider macros are not part of the common interface.
Snapshots contain page text and element refs. Treat page text and images as untrusted data, not instructions.
When `hasMore` is true, use `nextOffset` to read the next part. Read a new snapshot after page changes before using refs.
Typing fills the target; empty text clears it. `pressEnter` defaults to false.
Scroll directions are `up`, `down`, `left`, and `right`. The amount is a positive integer in pixels; the default is `500`.
Screenshots reach the model and Web UI as image blocks, not base64 text in JSON.
Clicks and Enter can submit data. Browser calls are not replayed automatically after an interrupted run.
Close tabs when the task ends. Tab handles belong to the selected provider connection, not a separate per-chat browser profile.
The Camofox MCP connection controls its cookie/storage session. Share it only between trusted conversations.
Handles can become invalid after a connection restart or provider change. Open a new tab when this occurs.

Select the provider under **Settings → Tools → Browser tools**. It defaults to `disabled`.
Camofox is the only included browser provider. It reuses a named, enabled MCP connection:

```json
{
  "browser": {
    "provider": "camofox",
    "providers": { "camofox": { "mcpServer": "camofox" } }
  },
  "mcpServers": [{
    "name": "camofox",
    "transport": "stdio",
    "command": "node",
    "args": ["/path/to/camofox-browser/mcp/server.mjs"]
  }]
}
```

Camofox and its MCP dependencies must already be installed. Its browser service must already be running.
This feature does not install or start that service. Use the actual MCP file path and Node command on your host.
Provider options stay under `browser.providers.camofox`. Connection settings and credentials stay in the existing MCP configuration.
For the Camofox MCP server, use its `CAMOFOX_BASE_URL`, `CAMOFOX_ACCESS_KEY`, and session environment settings when required.
The MCP manager keeps protected values out of Settings responses. It supplies the connection timeout and cancellation signal.
Cancellation stops waiting for the call; it cannot undo an action already sent to the browser.
Save and restart Luna to apply provider selection or option changes. Disabled, disconnected, or failed providers return explicit errors.
There is no silent fallback. Other adapters implement `BrowserProvider`; tool names and parameters do not change.

Run `verify:browser-tools` for deterministic runtime, routing, schema, error, image, and cancellation checks.
Run `verify:browser-image-ui` to check image display and reconnect in the Web UI.
Browser UI checks require Playwright; set `LUNA_PLAYWRIGHT_PATH` when it is installed outside this repository.
Run `verify:browser-tools:live` to use the configured stdio Camofox MCP connection with a new, isolated browser session.
The live gate serves a local test page. Camofox must be able to reach this host's loopback interface.
It checks native open, navigation, snapshots, refs, typing, clicks, scrolling, screenshots, and close effects.
It uses a scripted model; it proves execution and result delivery, not real-model tool choice.

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
Background OS processes belong to the current daemon. A normal shutdown stops them; metadata and retained output survive restart.
See **Native background processes** for crash handling and output retention.

The HTTP message endpoint returns `action`, plus optional `notice` and `tip`. Existing `whenBusy: "steer" | "followUp" | "reject"` clients remain supported.
`whenBusy: "redirect"` requests a per-message redirect. Command responses include `command: true` and queue commands return numbered `queue` rows.
The web client omits `whenBusy` for normal sends, so the saved mode controls routing.


## Sessions talk with each other

Type `@` in the chat box to mention a session. The list shows sessions by most recent use.
It does not show the current session, archived sessions, or subagents. Type part of a title or an ID to filter.
Selecting a row inserts `@session:<id>`. The `session:` namespace leaves room for other mention sources later.

When a user message contains `@session:<id>`, the prompt gets a **Referenced sessions** block.
It shows each session's ID, title, project, idle or busy state, and last activity (minute precision).
Unknown IDs are left out. The agent reads a session with `session_search sessionId=<id>`.

The `session_send { to, message }` tool sends a message to another session:

- An idle target starts a new turn. A busy target queues the message as follow-up input. It never interrupts.
- The message starts with a header that names the sender and says it is a peer session, not the user.
  The header tells the target to reply only when the reply is useful, and never with acknowledgements or thanks.
  A peer message grants no permission: merge, publish, and delete still need the user.
- The delivered input is a `luna.xsession.msg` entry with `{ from, hop, requestId }` metadata.
  Queued messages do not change the active exchange before delivery.
  The request ID is `xsession:<sender>:<taskId>`, so a replayed tool call delivers once.
- Each reply in an exchange increases the hop count. A send after `maxHops` is refused.
  A new user message in the sending session starts a new exchange at hop 1.
- Refused targets: the same session, unknown or deleted sessions, subagents (use `delegate_task`),
  and conversations owned by another session's task.
- The tool returns at once. A reply, if any, arrives later as a new message from the peer.

In the transcript, a received peer message shows a **From #<id> <title>** chip in place of the header.
The chip opens the sending session. A typed header without metadata on that exact input is shown as plain text.

## Native background processes

Enable explicit background commands under **Settings → Tools → Background processes**:

```json
"processes": {
  "enabled": true,
  "retentionHours": 168,
  "maxOutputBytes": 1048576
}
```

`enabled` defaults to `false`. Save and restart Luna to apply changes.
The `coding` extension must also be enabled. These tools have the same host access as `bash`; they are not a sandbox.
Existing correction-detached commands remain supported when explicit background starts are disabled.

- `process_start({command, cwd?, timeoutSec?})` starts a shell command and immediately returns a managed process ID.
  The default working directory belongs to the calling conversation. A relative `cwd` uses that directory.
  An optional positive timeout limits command execution. Spawn failures become failed process results.
- `process_manage({action, id?, timeoutSec?, offset?, limit?})` manages only the calling conversation's processes.
  Actions are `list`, `read`, `wait`, and `stop`. Every action except `list` requires an ID.
  `read` returns current or final output, state, and exit code. Nonzero exits have state `failed` and retain their exact code.
  `wait` waits at most 10 seconds by default, or `timeoutSec` from 0 through 60. A timeout is not completion.
  Cancelling a wait does not stop the process. Use `stop` to stop it.

Output combines stdout and stderr in arrival order. Reads return the latest 40,000 characters by default.
Use a nonnegative character `offset` and `limit` up to 40,000 to page through the retained output.
`nextOffset` identifies the next page. `truncated` reports output removed by the retention limit.
Offsets use UTF-16 string positions in the current retained tail. Page boundaries keep complete Unicode characters.
New output can shift that tail while a command runs.
For `list`, `offset` is a process index and `limit` is a process count. Large lists require smaller pages.
Encoded response size can reduce an output page. Use `nextOffset` rather than assuming the page length.
Process summaries show a command preview; `commandTruncated` identifies a shortened preview.
Completed processes retain metadata and output for `retentionHours` (default seven days).
Each process retains at most `maxOutputBytes` of UTF-8 output (default 1 MiB; allowed range 1 KiB through 16 MiB).
Private snapshots are saved under `<dataDir>/processes`, at most every 250 milliseconds during output, and at completion.
This is bounded retained output, not an unlimited full log.

Completion submits one follow-up result to the owning conversation and resumes Luna automatically.
It queues behind current work instead of interrupting it. The result includes a bounded output tail.
Shell output is untrusted data. Pending delivery survives restart and uses a stable request ID to prevent duplicate submissions.
If `cron.notifyUrl` is set, an external completion notification carries status only, not shell output.
Closing a viewer or stopping the conversation does not stop an admitted background process.

On POSIX hosts, `stop` and normal daemon shutdown kill each running command's process group and wait for execution to settle.
Execution completes when the launched command or shell exits. Do not append `&`; `process_start` already runs in the background.
Children that outlive that shell are no longer managed after its completion.
Descendants that create another process group or session can also escape this termination boundary.
Normal shutdown retains stopped results. After an abrupt daemon failure, unfinished saved jobs become `interrupted`.
The daemon does not reattach to or restart those commands. Surviving OS processes may still run after a crash.
An interrupted result does not prove that the old command stopped. Inspect the host before repeating destructive commands.
Saved output and completed exit codes remain available after restart until retention expires.

Run `pnpm run verify:process-tools` for real shell execution through the native runtime tools.
The test uses a scripted model; it does not prove real-model tool choice.

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

## Session titles

A session without a title shows its first message, shortened to 60 characters.
Automatic titles replace that fallback with a short generated title:

```json
"auxiliary": {
  "session_title": { "provider": "openai", "model": "gpt-4.1-mini" }
}
```

Without `session_title`, titles use the `side_question` route. Without either route, automatic titles are off.
The session's own model is never used, so a large session model does not change the cost.

- Timing: when a user message is stored, in parallel with the turn. An instant title uses the first non-empty line,
  shortened to about 48 characters. Forks and subagent children are skipped.
- Cost: a separate auxiliary call with thinking off. Input is the user message (up to 1,000 characters),
  plus the subject and description of any `#<id>` board references in that message. References are resolved
  against the session's project board (including General and archived cards); missing and other-project cards
  are ignored. Added board context is limited to 2,000 characters with an explicit truncation marker.
  Card details are supplied as context, not instructions. Output is at most 512 tokens. Usage is recorded against the session.
- Failure: the instant title stays. Later user messages can retry during the first three user turns,
  with at most three automatic model calls per session per process. Retries use the latest user message and its references.
  A successful generated title stops automatic naming; greeting placeholders remain eligible for upgrade.
- User titles win. Automatic titles never replace a rename, including a rename made while the call runs.
- **Generate title** in the session menu replaces the current title on request, using the opening message and current
  details of its board references. It is unavailable without a route.
- `session_search` shows stored titles (renames and generated titles) instead of the first message.

## Web frontend development

The web frontend uses Vue 3, Vite, TypeScript, Tailwind CSS, and shadcn-vue.
Run `pnpm run build:web` before starting the server. The server serves the build from `dist/web`, including the service worker.
The server does not need the frontend source files at runtime. Rebuilds update the served page and asset list without a server restart.
During a rebuild, requests can fail while Vite replaces the output files. Reload after the build completes.
Run `pnpm run dev:web` for the Vite development server. It forwards API requests to Luna on port 8787.
Use `pnpm run typecheck:web` to check Vue components. `pnpm run test` includes frontend type checking and the production build.

## Image analysis

`vision_analyze(image_url, question, region?, use_active_model?)` accepts a local path, an HTTP(S) URL, or an image data URL.
Load the full image first. Then use `region` to inspect small text.
`region` is `{ "x": 0, "y": 0, "width": 200, "height": 100 }` in original-image pixels.
All values must be integers. Regions outside the image are rejected. Cropping occurs before resizing.
Local paths use the conversation working directory.

The tool is offered only when the active model accepts images or a configured auxiliary vision model resolves with credentials.
The runtime checks the model catalog. Unknown capability does not enable native routing.

```json
{
  "auxiliary": {
    "vision": { "provider": "openai", "model": "gpt-4o" }
  },
  "vision": {
    "image_mode": "native",
    "history_budget_bytes": 262144,
    "long_edge": 2048,
    "hard_bytes": 1048576,
    "max_calls_per_image": 0,
    "subagent_max_calls_per_image": 3,
    "profiles": {
      "example-provider": { "tool_result_images": false }
    }
  }
}
```

These values are the defaults, except the example auxiliary route and profile.
`image_mode` accepts `native` or `auxiliary`. Settings changes apply to later requests and tool calls without restart.
Profiles use a provider ID or `provider/model`. A model profile takes precedence over a provider profile.
Set `tool_result_images` to `false` when a deployment rejects images in tool results.

Native routing requires native mode, a known image-capable model, a supported transport, and no profile veto.
Capability-check errors use the auxiliary route.
Native results contain text and an image block. The provider adapter converts this block to its image input format.
The active model inspects the pixels directly. Later requests resend those pixels from history.
Both byte limits measure the base64 payload. The tool resizes and re-encodes to meet both limits and the long-edge cap.
It returns an error if the image cannot fit.

Auxiliary routing uses `auxiliary.vision.model`, temperature `0.1`, and a 120-second timeout across attempts.
It sends the full-resolution image, or the full-resolution crop, with this prompt:
`Fully describe everything, then answer: <question>`.
A size rejection permits one smaller-image retry. An empty reply permits one further attempt.
The main model receives only `{ "success": true, "analysis": "..." }`, not auxiliary pixels.
Some visual detail can be lost in that text.

If native routing is rejected and no auxiliary client resolves, the tool returns an explicit error.
For a supported active vision model in native mode, the error offers a retry with `use_active_model: true`.
That explicit option bypasses only the profile veto. It cannot enable image input for a text-only model or an unsupported transport.
It does not change configured image mode or future calls.

A zero call limit means unlimited. Main agents have no default cap; subagents default to three calls per source image.
Counts persist across turns. Crops share their source image's count.
A native source-and-region pair is attached only once per turn. Different regions are separate variants.
An image already attached in the current turn is not attached again.
Duplicate skips do not consume the configured call limit. Failed analysis attempts after source preparation do consume it.

Sources are copied to private temporary files, with directory mode `0700` and file mode `0600`.
The tool deletes only its temporary files on success, error, or interruption. User files are never removed.
SVG and BMP sources become PNG. External SVG resources and entities are rejected.
Downloads reject private, loopback, link-local, multicast, reserved, and translated IP addresses.
Each redirect is checked. Connections use the checked IP while retaining the URL host for TLS verification.
Downloads retry once for network errors or HTTP 5xx, with at most five redirects and a 30-second download deadline.
Transport safety limits are 32 MiB per source and 40 million decoded pixels.
An interruption returns `Interrupted`.


## Image generation (ChatGPT subscription)

Image generation uses the ChatGPT subscription saved by the Codex CLI. It does not use an OpenAI API key.
It is disabled by default. Select the provider explicitly:

```json
{
  "image_gen": {
    "provider": "openai-codex",
    "openai-codex": {
      "model": "gpt-image-2",
      "quality": "low"
    }
  }
}
```

Sign in with `codex login` using ChatGPT. The adapter reads the file-backed Codex login from
`CODEX_HOME/auth.json`, or `~/.codex/auth.json` when `CODEX_HOME` is unset.
Set `image_gen.openai-codex.codexHome` to select another Codex home explicitly.
Relative configuration paths resolve against the config file's directory.
Keyring-only Codex credentials are not supported; this adapter requires file-backed tokens.
Luna's separate **OpenAI / Sign in with ChatGPT** chat login is not substituted for the Codex login.
These OAuth flows use different credentials; the image adapter leaves the chat login unchanged.

`OPENAI_API_KEY`, API-key-mode Codex credentials, and the paid OpenAI Images API are never used.
There is no paid fallback. Subscription plan limits and image quota still apply.
The adapter posts to the native Codex `images/generations` and `images/edits` endpoints at
`https://chatgpt.com/backend-api/codex/`, not a chat-model prompt that might skip image generation.
It sends Luna's own client identity and the selected account/residency headers.

Availability checks read only the selected adapter's local credentials. They do not refresh tokens or contact OpenAI.
On execution, a token near expiry is refreshed using the official Codex app-server `account/read` RPC.
No model turn is started. Codex owns refresh-token rotation and credential-file writes.
The refresh process uses `codex` from PATH; `image_gen.openai-codex.codexCommand` can override that executable.
Concurrent calls share one refresh. If the selected account changes during refresh, the image request fails before submission.
Cancellation stops waiting but lets an active, bounded refresh finish saving rotated credentials.
The helper process closes after refresh or failure. Refresh failures require a fresh `codex login`; they never switch accounts or auth types.

Remove `image_gen.provider` to hide the tool.
Provider and capability changes apply on the next tool listing, including existing conversations.
Changes to the daemon's environment require restarting it.

`image_generate` requires a nonempty `prompt`.
`aspect_ratio` accepts `landscape` (16:9), `square`, or `portrait` (9:16); landscape is the default.
Requests specify sizes 1536×864, 1024×1024, or 864×1536 respectively.
The supported model is `gpt-image-2`. Configured `quality` accepts `low`, `medium`, or `high`; the default is `low`.
The subscription backend can ignore size or quality. The result records `requested_size`, measured `pixel_size`,
`requested_quality`, and any `reported_size` or `reported_quality`. `aspect_ratio` records the requested orientation, not a guaranteed exact output ratio.

The tool accepts `image_url` and `reference_image_urls`. At most 16 source images are allowed in total.
Sources select editing; no sources select text-to-image. Upscaling and creative controls are not advertised for Codex.
The schema includes only the selected adapter's supported fields and is rebuilt for every listing.
Local sources must resolve inside the conversation working directory (or configured `cwd`).
The file descriptor is checked after opening, so symlinks cannot escape that directory.
This is source-file confinement, not an operating-system sandbox.
HTTP(S) sources use the existing vision loader, with public-address checks, pinned DNS, redirect checks, and byte/pixel limits.
Data URLs are also accepted. Sources are decoded before provider dispatch; adapters receive pixels, not unchecked paths or URLs.
The Codex adapter normalizes edit sources to PNG and applies a 25 MiB per-image upload limit.

Each generation call makes one image submission. There is no automatic generation retry, provider fallback, or interrupted-call recovery replay.
Cancellation cannot restore quota already consumed by a submitted request.
Generated PNG files remain in `<dataDir>/generated-images/` with private file permissions. There is no automatic retention cleanup.
Success results include `success`, `image`, `model`, `prompt`, `aspect_ratio`, `modality`, `provider`, and `upscaled`.
Errors include `success: false`, `error`, and `error_type`. Server error bodies and credentials are not exposed.
The tool returns a bounded image preview for chat delivery. If preview delivery fails, the successful file path is retained.
Use `vision_analyze` on the returned local path to inspect the original.
To edit a generated file outside the conversation directory, copy it into that directory first.

Provider adapters implement `ImageGenProvider` in `src/image-gen.ts`.
The current adapter is `src/plugins/image_gen/openai-codex.ts`; authentication is in `src/codex-image-auth.ts`.
Register new adapters explicitly. Directory contents are not executed automatically.
Adapters must ignore unknown request fields. The dispatcher forwards only advertised controls.
Unsupported editing is checked before calling an adapter. JavaScript `TypeError` is `provider_exception`, not a Python keyword-argument error.
Unknown selected providers get one registry refresh attempt, then `provider_not_registered`.
Other providers, FAL, managed Nous/Krea/Portal gateways, and remote file synchronization remain unimplemented.
Unsupported gateway and nonlocal execution routes fail explicitly.

Offline checks: `pnpm run verify:image-gen` and `pnpm run verify:image-gen-ui`.
The opt-in live check is `pnpm run verify:image-gen:live --live`.
It uses an isolated runtime, submits exactly one real subscription generation, verifies chat preview delivery,
and retains the generated image under the configured data directory. It never changes live configuration.
The live check is excluded from the default suite and requires explicit permission to consume subscription quota.


## Whole-video analysis

`video_analyze(video_url, question)` sends a complete video to an auxiliary provider and returns text only.
It never attaches the video to the main conversation. It does not extract frames, resize, crop, or apply image history/call limits.

The tool is offered only when an authenticated auxiliary vision client resolves.
An explicit `auxiliary.vision` provider is authoritative. Without it, resolution tries the active provider, `openrouter`, then `nous`.
Automatic selection prefers a Gemini catalog model within each provider, then the active model, then other image-capable models.
An image-capable catalog entry is not proof of video support. Use a video-capable model such as Gemini.
Unsupported APIs/models return a structured error rather than sending the video to the main model.

```json
{
  "auxiliary": {
    "vision": { "provider": "openrouter", "model": "google/gemini-2.5-flash" },
    "video": { "model": "google/gemini-2.5-flash" }
  },
  "video": {
    "blocked_paths": [],
    "blocked_hosts": [],
    "timeout_ms": 180000
  }
}
```

The video model uses this precedence: `auxiliary.video.model`, `auxiliary.vision.model`,
`AUXILIARY_VIDEO_MODEL`, `AUXILIARY_VISION_MODEL`, then the resolved catalog model.
The video model override keeps the resolved vision provider. Credentials, endpoint overrides, and headers come from `Models.getAuth`.
They use the existing provider environment, stored credentials, and OAuth resolution. No new credential file is added.
OpenAI-compatible chat-completion APIs receive one `video_url` data URL.
The direct Gemini API receives the same complete base64 bytes as one `inlineData` part.
Other API types are not supported. Provider HTTP redirects are refused to prevent credential forwarding.

The analysis prompt is `Fully describe everything: visuals, motion, audio cues, text overlays, scene transitions. Then answer: <question>`.
Temperature is `0.1`. `video.timeout_ms` must be at least `180000`; that deadline covers both attempts.
An empty response is retried once. A successful result is `{ "success": true, "analysis": "..." }`.
Errors are `{ "success": false, "error": "...", "analysis": "..." }`.
Friendly errors distinguish interruption (`Interrupted`), timeout, authentication, rate/quota, size, unsupported input/model, and access failures.
Provider error bodies and credentials are not returned.

Sources can be local regular files (relative to the conversation working directory) or public HTTP(S) URLs.
Luna-pi has no remote terminal backend or media resolver; remote paths and data URLs are unsupported.
Local files remain in place and are never removed. Video-specific read guards resolve symlinks and block known credential paths,
including the runtime config, auth/MCP credential files, `.env*`, `.ssh`, `.aws`, and `.gnupg`.
`video.blocked_paths` adds blocked files/directories, relative to the conversation working directory.
These guards do not change the policy of other tools.

URL downloads reject embedded credentials, nonpublic/mixed DNS addresses, and non-HTTP(S) redirects.
DNS addresses are pinned to the checked socket address. Every redirect repeats SSRF and site-access checks.
`video.blocked_hosts` blocks exact hostnames and their subdomains, without a scheme or port.
Downloads permit five redirects, three retries after the initial transient failure, and a 60-second timeout per attempt.
Download size is limited to 50 MiB, including streamed responses without a Content-Length header.
Downloads use private directories in `<dataDir>/video-cache`; owned files are removed on success, error, and interruption.

Supported suffixes are `mp4`, `webm`, `mov`, `mpeg`, `mpg`, `avi`, and `mkv` (case-insensitive).
MOV maps to `video/quicktime`, MPG/MPEG to `video/mpeg`, and WebM to `video/webm`.
AVI and MKV intentionally map to `video/mp4`. Other suffixes return `Unsupported video format`.
Files larger than 20 MiB add a slow/rejection warning. Base64 payloads larger than 50 MiB fail with `compress or trim`.
No compression is performed automatically.

Run `pnpm run verify:video` for deterministic source, transport, auxiliary-request, and real-runtime tool tests.
These tests use controlled provider responses. They do not establish real-provider video understanding.
A live video-capable provider call requires explicit permission and is not part of the default test chain.

After approval, run a real clip with an expected answer pattern:

```sh
LUNA_VIDEO_LIVE_APPROVED=1 LUNA_CONFIG=/absolute/path/luna.config.json \
  pnpm run verify:video:live /absolute/path/clip.mp4 "Describe the motion and colors." "red|blue"
```

Review the returned description against the actual clip. A regex match alone does not prove complete video understanding.
The live script does not start or restart the daemon or edit configuration. Provider auth can refresh stored OAuth credentials.

## General chat board

The built-in **General** project is always available. It shares one persistent board across sessions in **Chats**.
Existing unlinked sessions use it automatically. Named project boards stay separate.
General does not change a conversation's working directory. It cannot be renamed, edited, or deleted.
Scheduled runs and delegated children do not receive the board tool.

- `GET /v1/projects` includes `{ "id": 0, "name": "General", "cwd": "", "general": true }` before named projects.
  The empty directory means General has no directory override.
- `GET /v1/sessions` and `GET /v1/sessions/:id` report `project: 0` for General chats.
- `POST /v1/sessions` accepts `project: 0`. Omitting `project` also uses General.
- Creation also accepts optional `model: { provider, modelId }` and `thinkingLevel` overrides. Valid reasoning levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Omitted overrides use the configured defaults. The empty chat keeps explicit choices locally and sends them when the first message creates the session.
- Existing board and card routes accept `/v1/projects/0/board` and `/v1/projects/0/cards`.
- `PATCH` and `DELETE /v1/projects/0` return `409`. The name General is reserved for new projects.
- Deleting a named project keeps its conversations and directories. Those conversations then use General.

Open **Board** from the sidebar. It selects the active chat's project when opened.
General cards also appear in the composer's `#` picker. Card references remain scoped to the selected project.

## Board events

A card whose owner is `session <id>` sends that session short events. Free-text owners such as `m57` get none.
An idle session starts a new turn. A busy session queues the event. A session that no longer exists loses the owner.

- A user change through `PATCH /v1/projects/:id/cards/:cardId` (status, archive, owner) sends one line to the owner.
  Changes made with the `board` tool send nothing to the changing session.
- `done` or archive sends a final event, then clears the owner.
- Blocked: the `board` tool sets `blocked` to a short reason, for example `needs your decision on X`. The board shows it. An empty string clears it.
- Answer: `PATCH` with `{ "answer": "text" }` sends the answer to the owner and clears the blocked reason.
- Dependency wake-up: when a card reaches `done`, the owner of each card that waits on it gets one line
  (`#40 is done, you can start #52`). If other blockers remain, the line names them.
- Activity: `GET /v1/projects/:id/cards/:cardId/activity` lists who changed the card and when, newest first
  (`user` or `session <id>`). The card editor shows it.

## Manual session pruning

In **History → History actions → Prune sessions**, enter a positive whole number of days (default seven).
The preview counts sessions across all projects. Archived sessions are excluded unless **Include archived sessions** is selected.
The selected session and open split tiles are protected. Running tasks, background processes, and side questions are also protected.
Pinned sessions have no additional protection. There is no automatic schedule or configuration setting.

Age uses the newest user or assistant message timestamp, including cross-session messages.
Creation time protects newer sessions and forks with inherited old messages. Empty sessions use their creation time.
Sessions with no known message or creation timestamp are kept. A day means 24 hours; the cutoff is strictly older than the selected age.
Renaming, pinning, archiving, and reading do not count as message activity.

Both endpoints require the normal API authorization:

- `POST /v1/sessions/prune/preview` accepts `{ "days": 7, "includeArchived": false, "excludeIds": [123] }`.
  It returns `{ "ids": [456, 789] }` without deleting sessions. `excludeIds` contains the sessions the client must keep.
- `POST /v1/sessions/prune` accepts the same fields plus `"ids": [456, 789]` from the preview.
  It rechecks age, archive state, exclusions, running work, and descendants on the harness mutation line.
  It returns `{ "deleted": [456, 789] }`, which can be smaller than the preview. It never adds unconfirmed sessions.

All fields are required. Unknown fields, invalid IDs, and nonpositive or fractional days return `400`.
An empty confirmation list deletes nothing. Disabled conversation management returns `404`.
A fork or delegated child must also qualify before its parent can be removed.
Recent, archived, running, excluded, or unconfirmed descendants protect their ancestors from cascading deletion.
Deletion uses the existing atomic hard purge, including messages, descendants, documents, metadata, and search entries.
It is permanent. A failed purge leaves the selected sessions intact; the UI reports the error. A storage fault can require a daemon restart before retry.
