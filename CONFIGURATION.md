# User settings

Luna reads `luna.config.json` from its launch directory. Set `LUNA_CONFIG` to use another file.
An explicit path must exist. Without an explicit path, startup creates the default file if necessary.
Use `luna.config.example.json` as an example.

Open **Settings** in the Web UI to edit the same file on a full page.
The page has eight task-based categories:

- **Chat:** default instructions, messages during a response, usage-limit recovery, failed-response queues, and session messaging.
- **Models:** main model, subagent defaults, task-specific models, and model catalog refresh.
- **Accounts & connections:** provider accounts, custom providers, MCP connections, and execution machines.
- **Tools:** web access, browser control, background commands, built-in tool groups, and disabled tools.
- **Memory & skills:** extra skill directories, disabled skills, conversation learning, and links to saved memory, skills, and lessons.
- **Media:** image analysis, image generation, and video analysis.
- **Automation:** scheduled-run defaults, skill improvement, and a link to Cron jobs and reports.
- **System:** daemon LAN/Tailscale addresses, data directory, working directory, HTTP server, and configuration-file information.

Desktop uses a category sidebar. Mobile uses a vertical category index and an **All settings** back action.
Primary groups are visible. Advanced options expand within their relevant group.
Search matches labels, descriptions, keywords, and configuration paths across all categories.
Each result shows its location, state, and application timing. Selecting a result reveals and focuses the field.
Direct field links include `/#settings/chat/usage-limits/enabled` and `/#settings/models/task-models/video/model`.
Legacy category links (`general`, `context`, `images`, and `workspace`) redirect to their current destinations.

Preference categories share one unsaved draft. **Save settings** writes all draft changes.
**Discard changes** reloads saved values after confirmation. Leaving with unsaved changes requires confirmation.
Account and connection actions apply immediately through their own buttons; they do not use **Save settings**.
Save or discard the preference draft before changing accounts or connections.
Provider definitions and MCP definitions have structured **Edit definition** forms with explicit **Save definition** actions.
These forms retain all schema-supported options, revision protection, and secret markers.
Saved memory, skills, lessons, current subagents, execution machines, and Cron open their management panels.
Opening a related manager preserves the Settings draft. Analytics remains a separate main-navigation page.

Main and subagent thinking selectors are independent. Subagents can inherit the parent thinking level.
Disabled tools and skills use searchable pickers. Saved disabled items remain available to re-enable even when absent from the current catalog.
Field help shows defaults and readable units. Environment override names appear beside affected fields.
The legacy `learn.schedule` field is preserved but not editable. The fixed image-generation model is not an editable setting.
No JSON editing is required.

## LAN and Tailscale addresses for one daemon

Open **Settings → System → Connection addresses**. Luna discovers the daemon's
non-loopback IPv4 interface addresses on the first connection. You can add or rename them in **Connection addresses**.
Use **Save addresses**. If the connection fails, select **Switch to LAN** or **Switch to Tailscale** in the recovery popup. Bare hosts use HTTP
and port 8787. Full URLs keep their normal or explicit port. Addresses and the disconnect-prompt
preference are saved on this client, not in `luna.config.json`. All addresses use the existing server token.

Both addresses must reach the same daemon. Before sending the token to an alternate address,
Luna reads `/health` without credentials and checks its `daemonId`. It then authenticates and
checks `GET /v1/connection`, which returns `{ id, addresses: [{ url, label }] }`.
The daemon stores its stable ID in `<dataDir>/connection-id` with owner-only permissions.
Keep that file when moving or backing up the daemon. Do not copy it into an independent daemon.
The connection route requires the same authentication as other `/v1` routes.

**Show a switch popup when disconnected** opens a modal after a stream or startup
connection failure. On mobile, it opens as a bottom sheet with large address buttons. The popup
shows the disconnected address, identity-check progress, inline errors, and a **Not now** action.
The System address editor remains available even when daemon settings cannot load. The client does not switch automatically. It never retries message sends,
commands, or other writes because an address failed. Any existing explicit **Retry send** action
keeps its original request ID. Switching waits until current sends finish and settings edits are resolved.
It reconnects the main view and all loaded split panes without reloading the application.
Drafts, attachments, and unconfirmed-send state stay in memory.

The daemon must listen on an address reachable through both networks, usually `server.host: "0.0.0.0"`.
Non-loopback binding still requires `LUNA_TOKEN`. Tailscale must already be connected, and the firewall
must allow the daemon port. This feature does not install or start Tailscale or change firewall rules.
Discovery labels addresses in `100.64.0.0/10` as Tailscale; you can correct labels or enter addresses manually.

CORS permits the desktop shell and this daemon's own IPv4 interface origins on its configured port.
Known interface origins remain accepted for the life of the daemon, including after a network change.
It does not allow arbitrary website origins. An HTTPS browser page cannot switch to an HTTP address;
use HTTPS addresses or the desktop client. Custom proxy origins need separate proxy CORS configuration.
The browser's address bar stays at the page's original origin. An already loaded page can switch API
addresses; reopening that page still requires its original origin to be reachable. The desktop client
loads its shell locally and does not have this browser limitation.

## Fields

- `provider`, `model`: default model for new sessions and cron runs.
- `thinkingLevel`, `instructions`: defaults for new chat sessions.
- `afterFailedRun`: what happens to messages queued behind a response that failed. `keep` (default) leaves them queued until the next input,
  `continue` starts the next response with them, `withdraw` drops them. It applies to all sessions and live.
- Operator alerts: when `cron.notifyUrl` is set, a parked task (`task_parked`) or a failed daemon session (`session_failed`) is also posted there.
  A task is parked after it is cut off by a crash five times in a row. `GET /v1/tasks/parked` lists parked tasks;
  `POST /v1/tasks/:id/retry` runs one again.
- `autoContinue`: continue a turn automatically after a rate or usage limit resets. `enabled` defaults to `false`.
  Edit it under **Settings → Chat → Continue after usage limits**. Changes apply live.
  When a top-level turn stops on a limit error, Luna uses structured provider quota data when available.
  Claude native preserves rejected SDK quota windows and upstream quota headers. Codex preserves HTTP quota headers,
  streamed `codex.rate_limits` windows (including metered model buckets), and the refusal's `resets_at` field.
  These details stay in assistant diagnostics, not in the model-visible conversation.
  Luna waits until one minute after the latest blocked window resets. An exact reset requires a time for every blocked window.
  Other providers retain message-based recovery: epoch fields (`resets_at`), clock times with a zone
  ("resets 12:30am (Asia/Amman)"), durations ("try again in 6m0s", Google `retryDelay`), and ISO times.
  Without a complete reset time, Luna retries after 2, 10, 30, then 60 minutes, but not before any known blocked reset.
  The continuation says whether the reported reset time or an estimated retry delay has passed. It does not claim quota was checked.
  Reset timestamps already expired when the turn failed are not scheduled. Short transient errors still use the runtime's in-turn retries.
  Context overflow, authentication, billing, and `insufficient_quota` errors never wait.
  `maxWaitHours` (default `168`) skips longer waits. `maxAttempts` (default `5`) stops continuations that hit a limit again.
  A new message or **Cancel** next to the resume time cancels the scheduled continuation.
  Delivery rechecks the failed generation, provider/model, current input, pending user requests, archive state, and live enable setting.
  Recovery uses the selected request model, including local long-context aliases, rather than the transport's upstream model ID.
  These checks also run atomically during input admission, so cancellation or newer input before admission prevents delivery.
  Waits survive a restart. A stable submission ID prevents duplicate delivery after a crash.
  The saved wait remains until submission succeeds; failed delivery is retried after 30 seconds with the same ID.
  Waits saved by older versions without a failed-generation identity are discarded on startup; retry those turns manually.
  Cron runs, archived sessions, and subagents never continue automatically.
- `sessionTalk`: messages between sessions. `enabled` defaults to `true`; `maxHops` (1 through 20) defaults to `3`.
  Edit it under **Settings → Chat**. Changes apply live. See **Sessions talk with each other**.
- `providers`: custom AI endpoints, API formats, and model definitions. Built-in providers need no entry.
- `subagents`: optional `provider`, `model`, `thinkingLevel`, and `cwd` overrides.
  Set both provider and model, or omit both to inherit the parent model.
  Normal and forked children use these defaults. Children cannot delegate further.
  Children have no `ask_user_question`. A child that needs input or approval calls `session_handoff`.
  `delegate_task` then reports `needs_input` or `needs_approval` with the reason: `wait` returns early and `list` shows it.
  When the child's turn ends, the spawning session also gets one follow-up message (once per handoff).
  The message grants no permission. Answer the child with `delegate_task` `steer`; approvals stay with m57.
  `delegate_task` actions: `show` prints a child's full pending request and its last tool calls; `stop` is final until the child is steered.
  `spawn` also takes `worktree` and `base` (own git worktree on a new branch, under `.luna-worktrees` beside the project),
  `notes` (a facts file put in the brief) and `timeoutSec` (child budget, enforced when the parent runs `list` or `wait`).
  Every brief tells the child to end with a `receipt` JSON block; `wait` checks `commit_sha` against git. There is no `approve` action: only m57 approves.
  A handoff that ends while the daemon is down does not send a message, but `wait` and `list` still show it.
- `mcpServers`: stdio, HTTP, or SSE connections. `enabled: false` prevents connection.
  `defer` defaults to true. `timeoutMs` sets the tool-call timeout; the default is 600000 ms.
- `disabledTools`: tool names hidden from the model and refused if called. Applies to the next model request, including existing sessions.
- `disabledSkills`: skill names hidden from the skills catalog and `skill_view`. Applies at once.
- `dataDir`, `cwd`, `extensions`, `skillDirs`, `cron`, `improve`, `learn`, `server`: runtime settings.

Relative paths use the config file's directory. `~` expands to the user's home directory.

### Cron reports in the web UI

Open **Cron** from the sidebar. It opens a floating panel with **Reports**, **Jobs**, and **History**.
Reports contains the newest meaningful unread report for each job. New reports replace older reports for that job.
Opening a report marks it read and keeps its detail visible. Returning to the list removes the read entry.
Use **Mark unread** to restore the latest report, or **Mark all read** to clear the current inbox.
Older, superseded reports remain in History, even when marked unread. History is newest first and supports a job filter.
The sidebar badge counts unread inbox entries and is hidden at zero. Job health stays separate in Jobs.
Closing the panel preserves unfinished job edits. A successful run is not labeled as proof that an earlier problem was resolved.

## Interactive replies

Assistant replies can include `ui` fences for charts and plots, or `html` fences for custom interactive visuals.
The Web UI renders these blocks in message order, alongside text and `MEDIA:` attachments.
There is a combined limit of four previews per message. Extra blocks show their source without execution.
HTML runs only after the closing fence arrives. Use a `text` fence to show HTML as code without a preview.

HTML previews support self-contained markup, inline CSS, inline JavaScript, inline SVG, and data images.
**Source**, **Reload**, and **copy** controls operate on the displayed block. Source view preserves the running preview.
The preview area can be resized vertically. Reload and session reopen reset JavaScript state; generated HTML remains in the transcript.

`GET /html-preview` serves a public, stateless bootstrap document. It contains no transcript, token, or user HTML.
The shell signals readiness. The parent then sends only the block's HTML to that iframe, once per fresh shell. HTML is not stored or placed in a URL. An unresponsive shell shows a connection warning after ten seconds.
The endpoint is available without a built frontend. Vite proxies it to the daemon during development.
No configuration field is required. The example config includes an optional `instructions` reminder for self-contained HTML.

Both the iframe and the response CSP apply `sandbox allow-scripts`, without `allow-same-origin`.
This gives the document an opaque origin, including on direct visits to the endpoint.
Generated code cannot read the parent DOM, browser storage, or Luna's bearer token.
CSP blocks API fetches, external scripts/styles/images, workers, nested frames, objects, forms, and base URL changes.
The sandbox blocks popups, downloads, and top-level navigation. It does not prevent the iframe from navigating itself.
This is browser isolation, not a network firewall or a CPU/memory limit. Do not include secrets in generated HTML.
Existing workspace message handlers reject the preview's opaque origin.

The desktop CSP allows HTTP(S) frames for the configured daemon, but keeps the parent `script-src 'self'` policy.
A daemon document has its own CSP; `srcdoc` would inherit the parent's policy and block inline scripts.

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
Saving applies web provider selection and option changes to the next tool call.
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

The `learn` extension captures contextual evidence without a background model call. A learning proposal is a
reviewable change, not a new authority to write. **All proposals require user approval.** No automatic-write
policy is enabled. The existing `remember`, file, and skill tools retain their separate permission scope;
this feature is not an OS sandbox around those tools.

### Capture and diagnosis

- `learn.captureEnabled` (default `true`) enables idle scanning after `learn.idleMinutes` (default `30`).
  Capture stores source pointers, a bounded redacted summary, preceding task/action pointers, loaded skills,
  and a normalized content fingerprint. Full transcripts stay in conversation storage.
- Compaction entries, background notices, peer messages, delegated conversations, and scheduled prompts are
  not independent user statements. Quoted blocks are excluded from rule matching. Message length is not a filter.
- Tool errors stay signals, not automatic lessons. A signal key is the tool, the program (for `bash`, the last
  command of the line, plus the subcommand for `git`, `gh`, `pm2`, `pnpm`, `npm`, `cargo`, `systemctl`), and the
  normalized message. A bare exit code is its own cause, so `grep` exit 1 and `node` exit 1 never share a key.
  The failed call's arguments are stored in the signal context. Three kinds of failure create no signal: an
  expected result exit (exit 1 from `grep`, `rg`, `diff`, `cmp`, `test`, `git grep`, `pgrep`, or `git diff --quiet`),
  a stop signal (exit 130 or 143), and a harness interruption. Patterns from at least two conversations become
  visible for review. Legacy signals whose key ends in `:<harness>` stay in the ledger but are hidden from the
  queue. A later success from the same tool is only a recovery heuristic; it does not prove the same problem was fixed.
- `lesson_capture { session, message, kind }` captures a source missed by the heuristic, including long corrections
  and tool outcomes. `kind` is `rule`, `correction`, or `outcome`. User statements and tool results are checked
  against the original transcript, not model-supplied source text.
- `lesson_record` creates an unapplied candidate with `claim`, `cause`, `scope`, optional `skill`, `target`,
  `domain` (default `global`), `review_at` (Unix milliseconds), and `signal_ids`. `lesson_id` edits an existing
  candidate. A semantic diagnosis change invalidates previous assessments but retains them in history.
- Causes: `missing` (missing fact/procedure), `stale`, `not_loaded` (retrieval), `ignored` (available rule not followed),
  `wrong`, `conflict`, `project` (project-only knowledge), and `uncertain`. Ignored rules need a proposed code check,
  not more text. Conflicting and uncertain diagnoses cannot produce writes.
- `lesson_assess { signal_id, role, rationale }` records `explicit`, `support`, `conflict`, or `irrelevant` after
  context review. One explicit user statement can support a preference; inferred claims need distinct sources in
  at least two sessions. Repeated normalized content does not count twice. Semantic independence still needs
  review; fingerprints do not detect all paraphrases. Unresolved conflict blocks a proposal.
- `lesson_dismiss { signal_id | lesson_id, reason }` dismisses noise without deleting its evidence. It cannot
  dismiss an applied change or bypass a held proposal.

### Storage and write destinations

`learn.db` stores sources, assessments, observations, before/after change journals, and history. `memory.db`
stores facts and notes, plus keyed fact provenance and history. Both database files use mode `0600`.
Existing ledger records are retained, not reset.

| Scope | Destination and rule |
| --- | --- |
| `memory` | One global fact in `memory.db`; `fact` and stable `fact_key` are required. Versioned snapshots detect stale approvals. |
| `skill` | One managed `SKILL.md`; `skill` and complete `content` required. External skills remain read-only. Lint and a 1500-character growth budget apply. Retrieval fixes change the description. |
| `user` | `<dataDir>/USER.md`; requires an explicitly assessed user statement and full proposed content. Inferences do not qualify. |
| `projection` | `<dataDir>/MEMORY.md`, generated from explicit `memory_keys`. Existing manual contents remain untouched until approval. |
| `project` | One explicitly enrolled file, with a matching non-global domain. Project-only knowledge cannot enter a global destination. |

`SOUL.md` cannot be written through learning proposals. Identity changes remain a separate explicit task.
Enrol project files in `learn.files`, for example:

```json
{ "learn": { "captureEnabled": true, "idleMinutes": 30,
  "files": [{ "path": "/absolute/project/AGENTS.md", "domain": "project-name" }] } }
```

Enrollment is not approval of a change. Targets must be regular text files; symlink paths, binary files, and
files over 100 KB are refused. Learning refuses proposals whose snapshots contain recognizable credentials.
Redaction is heuristic, not a guarantee that every secret format is detected. Store databases and backups securely.

`lesson_propose` accepts `lesson_id`, optional `content`, `fact`, `fact_key`, `memory_keys`, `must_contain`, and
`critical` (review explanation). It saves a before/after snapshot and waits for the user. `must_contain` checks
text only; it is not behavioral verification. Proposals do not run shell commands or paid model benchmarks.
Skill learning rollback uses the learning journal, not the separate `skill_rollback` version series.

### Review, concurrency, and recovery

**Settings → Automation → Lessons** shows proposals, original source pointers, assessments, target changes,
observations, and review-due notices. Approve applies the exact reviewed change; Reject preserves the evidence.

- Memory application uses an immediate SQLite transaction and compares the complete prior snapshot.
- File application checks the exact reviewed contents, takes a cooperating-writer lock, and atomically replaces
  the target. It checks contents again before replacement and reads the result back. External editors do not use
  this lock: there is a narrow check/rename race. This is not a filesystem transaction against arbitrary writers.
- The journal records intent before apply and rollback. An interrupted change remains `applying` or `blocked` and needs
  explicit reconciliation; it is not automatically retried. Reconcile reads the target to distinguish not-applied,
  applied, reverted, and conflicting states. A leftover `.luna-learning-lock` requires manual inspection before removal.
- Rollback refuses a target changed after apply. A new skill/file can be removed only if its content still matches
  the approved version. Memory rollback restores the original fact and metadata. Snapshot history remains available.
- Legacy proposals lack reviewed source assessments and change snapshots, so they cannot be approved directly.
  Reject and create a new candidate using recaptured original evidence. Legacy `confirmed` entries are displayed
  as unverified legacy confirmations; loading a skill no longer confirms anything.
- `forget` removes that fact's current memory, provenance, and memory history. Source transcripts and existing
  learning journals are separate records and are not purged by this action.

### MEMORY.md projection

A projection is a complete, sorted selection of database facts, limited to 4000 characters. Overflow is refused,
not silently truncated. Missing or review-due facts cannot be projected. Approval checks both the selected fact
snapshots and the existing file. A database change or manual file edit marks the projection stale. The runtime
omits the stale file from the identity section, reports the problem, and keeps database recall available.
Refresh requires another reviewed proposal; no automatic file overwrite occurs. Manual files not yet adopted
as a projection retain their previous behavior. General `remember` updates clear old learning provenance rather
than falsely attributing new content to an older source.

### Outcomes and cost

`lesson_observe { lesson_id, session, message, outcome, relevance, evidence }` records a later relevant
`success`, `failure`, or `unknown`. Assistant claims alone cannot establish success. The observation is bound to
an applied change and source timestamp. Repeated source content is deduplicated. Reported failures mark a change
`ineffective`; no observations means effect unknown. The user can verify a successful observation only while the
applied target still matches and no later failure contradicts it. This verifies that observation, not every future task.

`learn_review` returns paged open lessons and signals (default 20, maximum 100), projection state, and observation
counts. Use `offset` for pagination, `history: true` for closed lessons and legacy signals, or `lesson_id` for evidence, change journal,
and revision history. Legacy signals lack original-source fingerprints and stay outside the default queue.
Metrics include reported outcomes, observed lesson/session pairs, and review-due items.
They are not independent proof of improvement. Manual review usage remains in the host session's usage records.

The legacy `learn.schedule` field is accepted only for configuration compatibility. It no longer schedules a
model job. Startup and settings reconciliation disable the old `luna-learn` job without deleting its history.
No replacement job is created. Idle capture makes **zero model calls**; review occurs in a requested normal
session or after a relevant correction. There is no automatic replay evaluator or automatic policy promotion.

HTTP routes:
- `GET /v1/lessons`: lessons, evidence, assessments, changes, observations, projection state, metrics.
- `POST /v1/lessons/scan`: deterministic idle capture (respects capture configuration).
- `POST /v1/lessons/:id/approve|reject|rollback|reconcile`: user decisions; `reject` accepts an optional `note`.
- `POST /v1/lessons/:id/verify`: user confirmation, body `{ "observation": <id> }`.

Implementation checks follow the repository's no-tests rule: compiler checks and frontend build only.
No regression fixtures or runtime verification scripts are shipped. Behavioral and browser verification are
still needed before claiming operational reliability or measured improvement.

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
Saving applies provider selection and option changes to the next tool call. Disabled, disconnected, or failed providers return explicit errors.
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
**Save settings** applies every change to the running daemon, including providers, MCP connections, web and browser routes, `cron`, `improve`, `learn`, `video` and `vision`.
Saving connects, reconnects or disconnects changed MCP servers. A server that fails to connect is reported after the save.
Removing a built-in from `extensions` applies live: sessions stop seeing its tools, sections and hooks on the next call. Its store and scheduler keep running. Adding one that did not start at boot needs a restart.
These startup settings need a Luna restart: `dataDir`, `cwd`, `skillDirs`, `processes` and `server`.
The UI shows a restart notice after you save one of them.

Environment variables still override the file: `LUNA_DATA`, `LUNA_CWD`, `LUNA_PROVIDER`,
`LUNA_MODEL`, `LUNA_HOST`, and `LUNA_PORT`. Settings lists active override names.

## OpenCode CLI provider

The `opencode-cli` provider runs models through the installed `opencode` background service, including its free
models. OpenCode's free tier only accepts requests from OpenCode itself, so Luna does not call the API directly.
Model ids look like `opencode/big-pickle` (`provider/model`, as printed by `opencode models`).

Luna keeps tool execution. Each conversation gets a loopback MCP server that lists Luna's tools. OpenCode's own
tools are denied (except `read`, which the free tier requires), and the session runs in an empty scratch directory.
A tool call is held open until Luna has run the tool and returned the result. Free models can be rate-limited or
removed at any time, and free providers may log prompts: do not send secrets to them.
Follow-up user messages continue the live opencode session instead of replaying the transcript, when the history
is an exact continuation; otherwise a new session replays it as text. User images go to vision models as file
attachments (images inside tool results are not forwarded). Free-tier errors (403, 429, 5xx) reach the chat with
the status and a hint. On start the provider checks the running opencode for the routes it needs and fails with a
clear message if one is missing (tested with 2.1.x).
`LUNA_OPENCODE_EXECUTABLE` selects the executable; the default is `opencode` on PATH. The routes used are marked
experimental, so pin the opencode version you tested.

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

## OpenAI long-context models

The built-in OpenAI provider reads its authenticated `/v1/models` catalog at startup,
on the existing hourly refresh, and when **Refresh models** is selected.
It accepts both subscription catalogs (`models` / `slug`) and API-key catalogs (`data` / `id`).
For each built-in chat model, a valid `context_window` updates its normal capacity.
When `max_context_window` is larger, Luna adds a separate entry labelled with that capacity,
for example **GPT-6 Sol (872K)**. There is no fixed model list or long-context limit.
Models marked hidden or unsupported do not produce variants. Missing or invalid limits do not
produce variants either. Models absent from the installed built-in catalog are not guessed:
the installed catalog still supplies capabilities, output limits, and pricing.

Both entries use the same OpenAI credentials and upstream model ID. Long-context selections
use the local ID `<upstream-model-id>-long-context`, with provider `openai`.
Luna removes that local suffix before sending the request. The selected capacity applies to
context tracking and runtime compaction. No additional provider or login is required.

Failed refreshes retain the last successful catalog in memory and report an error through the
existing model refresh status. A fresh process starts from the built-in catalog until discovery
succeeds. API-key catalogs that supply no context metadata do not gain speculative variants.
Large contexts can consume more usage; the built-in pricing tiers remain unchanged.

## Context usage

The chat context bar shows estimated active tokens, model capacity, and the percentage used.
It is green below 50%, amber from 50% up to the configured trigger, and red at or above the trigger.
A trigger below 50% takes precedence over green. Unknown model capacity is shown as unavailable.
The bar refreshes after tool results, model changes, and compaction. It is not a live tokenizer.
Older usage measurements are discarded after a summary changes the context boundary.
The separate token totals remain cumulative usage.

## Runtime compaction policy

Luna has no compaction settings. It uses the `pi-durable` defaults: reserve 16384 tokens, keep the most recent 20000 tokens,
and start a background compaction 32768 tokens before the blocking limit. A turn does not wait for a background compaction.
Emergency context-overflow recovery also compacts.
The pinned `pi-durable` dependency has a local pnpm patch in `patches/`. It adds redirect and steer handling only.
A `compaction` key in `luna.config.json` is an unknown key and the daemon refuses to start. Remove it.

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

`/undo N` removes the last N active user messages and subsequent replies and tool results from model context only.
N must be a positive integer and cannot exceed the remaining active user messages.
Chat history stays visible. File changes, tool actions, and durable task state are not reversed.
The command does not call the model. It persists across restarts and applies to subsequent history forks.
Repeated request IDs return the original receipt without undoing more messages.
The session must be idle, with no queued input or active compaction. Stop work or clear queued input first.
Undo cannot reach messages already replaced by a compaction summary or excluded by a context reset.
Peer messages and background completion reports do not count as user turns.

The web composer also handles `/compact` (summarize context now) and `/models` (open the model picker) locally.
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

### File mentions

The `@` list also has a **Files** group. It lists the working directory of the session's machine (the main host or an execution worker). Type a directory part to list another directory on that machine: `@file:~/x/`, `@file:/etc/`, `@file:../`. Selecting a directory goes into it. Selecting a file inserts `@file:<path>`.

When a user message contains `@file:<path>`, the prompt gets a **Referenced files** block with the absolute path, kind, and size. The file content is not in the prompt; the agent reads it with `read`.

`GET /v1/files?q=<typed path>&session=<id>` returns `{ cwd, entries }`. For a chat without a session, pass `worker`, `project`, and `cwd` instead of `session`.

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

`enabled` defaults to `false`. Save and restart Luna to apply changes (`processes` is a startup setting).
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
| `/review [focus]` | Requirements, claims, and diff | Read-only reviewer tools | Review report. See Session review |

An empty argument returns usage. `/btw` reports unreadable history, empty history, or unavailable provider credentials before starting.
`/bg` can start from an empty chat. Include all necessary task context in its prompt.
Images go directly to the new conversation. Audio attachments become local files with paths in its prompt.
Audio understanding requires an enabled tool that can read or transcribe those files; it is not a native audio model input.
Ordinary messages cannot contain audio. `/btw` ignores attachments.

The started receipt includes the prompt preview and job ID. Side-question and background results appear separately in the same chat.
Review jobs appear in the right session sidebar. Select a review to inspect its activity and report.
On narrow screens, including mobile, a review button in the conversation header opens the same inspector.
Reviews do not add report cards to the transcript or controls to the composer.
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
Review jobs also include an `activity` array of status, assistant-message, and tool-result events.
Tool events include their arguments, output, and error state. Activity updates use the same session event stream.
Retries with the same request ID reuse the same job; conflicting reuse is rejected.

## Session review (`/review`)

`/review [focus]` starts a read-only reviewer for the current chat. It judges two things: whether the agent
covered what you asked, and the quality of the code. It runs as a background job on its own model. Its activity and report appear in the review inspector,
opened from the right sidebar or the conversation header on narrow screens.
The report is not a main-history entry. The main agent sees it only if you click **Send to agent** on a
completed report. This sends the full report and focus as a user message to the same session. If the agent is
busy, the message waits for the active turn. Your composer draft stays unchanged. Repeated delivery of the
same report uses one request ID to prevent duplicate messages.

```json
"auxiliary": {
  "review": { "provider": "openai", "model": "gpt-4.1" }
}
```

Session status is `reviewing` while a review runs, even when the main agent is idle. After all reviews
finish, it becomes `review_finished` (Review finished), or `failed` with the review error. Foreground work
keeps its own `running` flag; unresolved questions still show Needs input or Needs approval. Opening the
session clears Review finished to Ready. New input or a newer main response supersedes an old report's
completion status. Desktop notifications include review completion when the app has no focus.
A daemon restart marks an unfinished review as failed rather than leaving Reviewing stuck.

`auxiliary.review` is required. Without it, `/review` returns an error. It never uses the session model.
Changes apply to the next review (**Settings → Models & accounts → Session review**).

File reads, searches, and Git commands run on the session's execution machine, including remote workers.
Commands have a 20-second timeout. They receive only that machine's `PATH` and `HOME`, plus fixed locale
and Git safety variables; they do not inherit daemon credentials or Git environment overrides.
Workers must advertise their executable search path. Restart an updated worker before using remote reviews;
older workers return an update error. Offline workers and failed execution requests stop the review instead of
supplying incomplete workspace evidence.

What the reviewer receives:

- All user messages (the requirements), capped at 30,000 characters, newest kept first.
- The agent's text replies (its completion claims), capped at 20,000 characters. Tool calls are named, not shown.
- Working directory, branch, `HEAD`, `git status`, the diff stat, and the diff against `HEAD`
  (60,000 characters, with a marker when cut). Untracked files are listed by `git status`.
- Your optional focus text.

What it can do: it has four tools, and nothing else.

| Tool | Limit |
| --- | --- |
| `read_file` | Text files under the working directory. Symlinks that leave it are refused. |
| `search` | `grep -E` under the working directory. Skips `.git`, `node_modules`, `dist`. |
| `git` | `status`, `diff`, `log`, `show`, `ls-files`, `rev-parse`, with an allowlist of flags. External diff and textconv programs are disabled. |
| `session_message` | Full text of one earlier message by its `#` index. |

It has no shell, no write tools, no delegation, and no way to run tests. The limits live in code, not in the prompt.
It stops after 40 tool rounds and then must answer. Usage is recorded against the source session.

The report has a verdict, request coverage, findings with file and line, and limits. If the workspace changed while
the review ran, the report says so. Committed work is not in the diff against `HEAD`. The reviewer finds it with `git log`.
Outside a git repository, it reviews by reading files.

Like other side jobs, results last for the current daemon process.

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
- `session_search` shows each session's live status. Its `status` parameter (one value or a list: `ready`, `running`, `reviewing`, `review_finished`, `finished`,
  `needs_approval`, `needs_input`, `limit_reached`, `failed`, `stopped`) keeps only matching sessions, alone or with `query`.
  `failed`, `limit_reached`, `needs_*` and `stopped` results include the reason (the error text for failures). A status filter
  checks the newest 300 sessions and returns up to 50 results.

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

## Card attachments

A card can hold files, stored in the daemon database with the card. Limits: 10 MB per file, 20 files per card.
Cards in `GET /v1/projects/:id/board` list their `attachments` (`id`, `name`, `type`, `size`, `created`).
The `board` tool shows attachment names in `get`. Deleting a card or project deletes its files.

- `POST /v1/projects/:id/cards/:cardId/attachments?name=<file>`: the request body is the raw file. `Content-Type` is kept.
- `GET /v1/projects/:id/cards/:cardId/attachments/:attachmentId`: downloads the file as an attachment.
- `DELETE /v1/projects/:id/cards/:cardId/attachments/:attachmentId`: removes it.

Each saved board card has a paperclip button to open its editor and select files.
The button shows the attachment count when files are present.
The card editor has an **Attachments** list with attach, download, and remove.
Supported image formats show a preview in this list. New cards must be saved before attaching files.

## Execution machines (first version)

One main daemon owns sessions, history, agent execution, models, skills, memory, settings, and schedules.
A worker runs only file and shell operations for sessions that explicitly target it.
Opening or sending instructions to a session never changes its execution machine.
Browser, MCP, web, image generation, vision, and video tools run on main.
In a worker session, they read local file paths from the worker.
`video_analyze` applies the credential checks and `video.blocked_paths` on the worker. Paths resolve against the worker's directory.
`image_generate` source images must be inside the worker's working directory.
The worker opens each protected file once. It checks the opened file and reads from it, so a symlink swap cannot redirect the read.
These protected reads need a Linux worker at the same Luna version as main. Other workers refuse them.
A generated image is copied into the worker's working directory.
If that copy fails, the tool reports `worker_delivery_failed` and gives the path of the copy on main. Do not regenerate the image.

### Register and connect

In **Settings → Tools & connections → Execution machines**, create a named machine.
Copy its token immediately. Luna shows it once and stores only its hash in `<dataDir>/workers.db`.
The token grants execution-worker access, not access to the shared HTTP API.
Removing a machine revokes its token and closes its connection.

Use the same package checkout and `pnpm install --frozen-lockfile` on the worker machine.
The worker needs Node.js compatible with this package. It does not need provider keys or a session database.
Set these environment variables through your shell or service configuration:

```sh
export LUNA_URL=https://your-main-luna
export LUNA_WORKER_TOKEN=lw_your_worker_token
export LUNA_WORKER_CWD=/home/you/Projects  # optional; default: home directory
pnpm run worker
```

Workers dial main over WebSocket on the main HTTP port. They need no inbound port.
Use HTTPS/WSS or a trusted private network. Do not send bearer tokens over an untrusted plain HTTP network.
Reverse proxies must forward the WebSocket upgrade at `/v1/workers/connect`.
Worker tokens permit arbitrary commands on the worker through sessions assigned to that machine.
Run workers as the desktop user, not as root.

### Web and terminal controls

The conversation header shows a machine control when workers are registered.
The Session panel selects the machine and working directory for a new conversation.
For an existing session, **Move future execution** changes only future file and command tools.
A turn or background process must finish or stop before execution moves.
An omitted directory uses the worker's default directory, or the main project's directory on main.
Project directories are main-host paths. They are not automatically reused on a worker.
Files, repositories, processes, and browser state do not move or synchronize.

The existing terminal client also has a shared-session mode:

```sh
export LUNA_URL=https://your-main-luna
export LUNA_TOKEN=your_main_api_token
# Optional: also set LUNA_WORKER_TOKEN to run the local worker in this same process.
pnpm run connect
# Equivalent: pnpm run chat connect
```

Commands:

- `/sessions`: list shared sessions, status, execution machine, and directory.
- `/open ID`: view a session and its live output without moving execution.
- `/new [WORKER_ID]`: create a shared session on main or the named worker id.
- `/machine main|WORKER_ID [DIRECTORY]`: explicitly move idle execution.
- `/status`: show the current execution machine and directory.
- `/stop`: stop the viewed session's turn.
- `/questions`: print pending questions and their call ids.
- `/answer CALL_ID JSON`: submit the same answer object used by the web question API.
- `/quit`: leave the client. An embedded worker also stops; a separate worker can stay online.

Normal input sends an instruction. The prompt remains available while the agent runs.
The old `pnpm run chat --session ID message` interface remains available.

### HTTP API

The session event stream (`GET /v1/sessions/:id/events`) includes a `submissions` array on
`entry_appended` events. Each record identifies a submission placed in that entry, including
its `requestId` and `entry` ID. The streaming messages endpoint includes the same metadata.
Clients can replace local pending messages atomically without comparing message text.
The usual standalone `submission` events remain unchanged. Reconnecting clients can read
`GET /v1/submissions/:id` because snapshots do not replay these lifecycle events.


All ordinary endpoints below require the main API token when authentication is enabled.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/files` | `@file:` completion: entries of the session machine's working directory, or of the typed directory. |
| GET | `/v1/workers` | List registered machines, capabilities, connection state, and last-seen time. No tokens. |
| POST | `/v1/workers` | `{ "name": "desktop" }` → `{ worker, token }`. Token shown once. |
| DELETE | `/v1/workers/:id` | Remove machine, revoke token, close its link. Existing sessions keep an unavailable target. |
| GET | `/v1/sessions/:id/machine` | `{ machine, cwd }`. `machine: null` means main. |
| PUT | `/v1/sessions/:id/machine` | `{ "worker": 1, "cwd": "/home/you/project" }`; null worker means main. Busy sessions return 409. |
| WebSocket | `/v1/workers/connect` | Worker protocol v1. Uses a separate per-worker bearer token, not the main API token. |

`POST /v1/sessions` accepts optional `worker` (numeric worker id or null) and `cwd`.
`GET /v1/sessions/:id` includes `machine` (`{ id, name, online }` or null).
Forks, delegated children, and background-task sessions keep their parent's execution machine.
Native background processes use that environment and retain their output centrally.
Files named by an assistant `MEDIA:` directive are fetched on demand from the source worker.
For sessions created through the API, existing answer attachments keep their source after execution transfers.

### Disconnection and recovery

History and last known progress stay on main when a worker disconnects.
In-flight calls fail. New file and shell calls fail clearly instead of falling back to main.
Calls are never automatically replayed after reconnect. A new link cannot reuse an old file-reader handle.
Worker shutdown and a detected connection loss abort its commands and close readers.
A hard crash can leave OS processes running. Main reports their state as unknown; check before repeating a command.
The worker reconnects automatically with bounded delay. Removing its token stops future connections.
New agent turns require main to be reachable. There is no independent desktop agent loop or offline session store.

Verification:

```sh
pnpm run verify:workers       # isolated main + worker process; real tools, scripted model
pnpm run verify:workers-cli   # real CLI, HTTP, SSE, explicit execution targeting
pnpm run verify:workers-ui    # real browser; draft target and explicit transfer
# Opt-in real desktop test. Copies a temporary bundled worker; installs no desktop service.
LUNA_TEST_DESKTOP=m57@192.168.1.11 LUNA_TEST_MAIN_URL=http://192.168.1.57 pnpm run verify:workers:desktop
```

## Manual session pruning

In **History → History actions → Prune sessions**, enter a positive whole number of days (default seven).
The preview counts sessions across all projects. Archived sessions are excluded unless **Include archived sessions** is selected.
The selected session and open split tiles are protected. Running tasks, background processes, and side questions are also protected.
Pinned sessions are always protected, including archived pinned sessions. There is no automatic schedule or configuration setting.

Age uses the newest user or assistant message timestamp, including cross-session messages.
Creation time protects newer sessions and forks with inherited old messages. Empty sessions use their creation time.
Sessions with no known message or creation timestamp are kept. A day means 24 hours; the cutoff is strictly older than the selected age.
Renaming, pinning, archiving, and reading do not count as message activity.

Both endpoints require the normal API authorization:

- `POST /v1/sessions/prune/preview` accepts `{ "days": 7, "includeArchived": false, "excludeIds": [123] }`.
  It returns `{ "ids": [456, 789] }` without deleting sessions. `excludeIds` contains the sessions the client must keep.
- `POST /v1/sessions/prune` accepts the same fields plus `"ids": [456, 789]` from the preview.
  It rechecks age, pin state, archive state, exclusions, running work, and descendants on the harness mutation line.
  It returns `{ "deleted": [456, 789] }`, which can be smaller than the preview. It never adds unconfirmed sessions.

All fields are required. Unknown fields, invalid IDs, and nonpositive or fractional days return `400`.
An empty confirmation list deletes nothing. Disabled conversation management returns `404`.
A fork or delegated child must also qualify before its parent can be removed.
Pinned, recent, archived, running, excluded, or unconfirmed descendants protect their ancestors from cascading deletion.
Deletion uses the existing atomic hard purge, including messages, descendants, documents, metadata, and search entries.
It is permanent. A failed purge leaves the selected sessions intact; the UI reports the error. A storage fault can require a daemon restart before retry.
