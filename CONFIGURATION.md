# User settings

Luna reads `~/.luna/luna.config.json` by default, independent of its launch directory. Set `LUNA_CONFIG` to use another file.
An explicit path must exist; relative override paths resolve from the launch directory. Luna does not fall back to a checkout-local `luna.config.json`.
Without an explicit path, daemon startup creates the default file if necessary; workers use defaults when it is absent.
Paths inside a loaded config resolve relative to that config's directory. Use `luna.config.example.json` as an example.

Open **Settings** in the Web UI to edit the same file on a full page.
The page has eight task-based categories:

- **Chat:** default instructions, messages during a response, usage-limit recovery, failed-response queues, and session messaging.
- **Models:** main model, subagent defaults, task-specific models, and model catalog refresh.
- **Accounts & connections:** provider accounts, custom providers, MCP connections, and execution machines.
- **Tools:** web access, browser control, background commands, Code Mode sandbox, built-in tool groups, and disabled tools.
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
Use **Save addresses**. Move addresses up or down to set their preference order. Place LAN first if you prefer it at home. Bare hosts use HTTP
and port 8787. Full URLs keep their normal or explicit port. Addresses and the disconnect-prompt
preference are saved on this client, not in `luna.config.json`. All addresses use the existing server token.

Both addresses must reach the same daemon. Before sending the token to an alternate address,
Luna reads `/health` without credentials and checks its `daemonId`. It then authenticates and
checks `GET /v1/connection`, which returns `{ id, addresses: [{ url, label }] }`.
The daemon stores its stable ID in `<dataDir>/connection-id` with owner-only permissions.
Keep that file when moving or backing up the daemon. Do not copy it into an independent daemon.
The connection route requires the same authentication as other `/v1` routes.

**Ask before switching addresses** requires confirmation before using another route. When disabled,
Luna probes saved alternatives concurrently after a connection failure and uses the first validated route.
Existing prompt preferences are preserved; disabling the former popup setting now enables automatic switching.
Each recovery probe has a three-second total deadline, including both identity and authenticated checks.
When you return to the app, Luna checks higher-priority addresses with two-second deadlines.
Preferred-route changes wait until every loaded pane is between turns. With confirmation enabled,
the dialog says **Preferred address available**, not **Connection lost**, for a healthy current route.
A **Not now** action dismisses the dialog until recovery or an address/preference change.
Dismissing a healthy-route suggestion does not suppress a later connection-loss dialog.

Startup failures remain in the shell with **Reconnecting…**, retrying from one second up to fifteen seconds.
Network-up, window-focus, and visible-page events also retry startup. Missing credentials and rejected tokens
still open login. Stream recovery waits for three consecutive failures or eight seconds of failed retries
before showing the recovery dialog; a successful event resets this count.
Ordinary API requests have a fifteen-second deadline, including JSON response bodies.
A send timeout means **delivery not confirmed**, not that the server rejected or missed the message.
Any explicit **Retry send** action keeps its original request ID. Luna never retries message sends,
commands, or other writes merely because an address failed.

Switching waits until current sends finish and settings edits are resolved. It reconnects the main view
and all loaded split panes without reloading the application. Drafts, attachments, and unconfirmed-send
state stay in memory. The first session attachment reads up to 500 history entries; subsequent feed
reconnects read the latest 100 and retain earlier loaded rows. Hydration has its own thirty-second budget,
separate from the ten-second stream-connection deadline. The stream's atomic snapshot still reconciles
current run state. Inline images and large snapshot payloads are unchanged.

The daemon must listen on an address reachable through both networks, usually `server.host: "0.0.0.0"`.
Non-loopback binding still requires `LUNA_TOKEN`. Tailscale must already be connected, and the firewall
must allow the daemon port. This feature does not install or start Tailscale or change firewall rules.
Discovery labels addresses in `100.64.0.0/10` as Tailscale; you can correct labels or enter addresses manually.

CORS permits the desktop shell, this daemon's own IPv4 interface origins on its configured port, and every origin in `server.publicUrls`.

## Public HTTPS address

To reach the daemon through a tunnel or reverse proxy, list its HTTPS origin in `server.publicUrls`, for example `["https://luna.example.com"]`. Use an origin only: no path, query, or credentials. Luna advertises each entry as a **Public** address in `GET /v1/connection` and allows it for CORS. The proxy must forward to the daemon port. The server token is still required for `/v1`, so always set `LUNA_TOKEN` before you expose the daemon. Restart Luna after you change `server`.
Known interface origins remain accepted for the life of the daemon, including after a network change.
It does not allow arbitrary website origins. An HTTPS browser page cannot switch to an HTTP address;
use HTTPS addresses or the desktop client. Custom proxy origins need separate proxy CORS configuration.
The browser's address bar stays at the page's original origin. An already loaded page can switch API
addresses; reopening that page still requires its original origin to be reachable. The desktop client
loads its shell locally and does not have this browser limitation.

## Pi 1.5 runtime and upgrade safety

Luna pins Pi AI, Pi Durable, and Chord to the same release family. Live chat keeps Luna's HTTP/SSE contract;
Pi conversation watches supply bounded live state, while commit observations drive persisted metadata and notifications.
History remains paginated and fork-aware. Closing or reconnecting a viewer does not abort a run or send its input again.

Pi 1.5 defers streamed partials and running tool output for up to about one second by default. Watches show that progress
before storage receives it. A crash can lose recent partial content; completed boundaries persist the state they consume.
Luna retains stock compaction and progress policies. This upgrade does not change saved provider/model defaults.

Before a production upgrade, stop active work and take a consistent backup of the resolved data directory and configuration.
Do not copy only an open SQLite main file and omit its WAL. Keep credential permissions restrictive.
Pi 1.5 writes `pi.live` version 3, generation task version 2, and tool task version 3. A package downgrade alone cannot
safely reopen all upgraded state. Rollback requires stopping the new daemon and restoring matching old code, dependencies,
compiled assets, and the pre-upgrade state snapshot. Work created after that snapshot is not present in the restored state.
Do not start two writing daemons against the same data directory.

Dependency patches retain Luna's persistent tool ceilings, redirect/grouped-steering behavior, submission receipts,
selected model identity in failures, and provider quota diagnostics/retry ownership. Guarded server admissions use Pi's
transactional submission API, not a host callback stored in a submission.

## Fields

- `provider`, `model`: default model for new sessions and cron runs.
- `thinkingLevel`, `instructions`: defaults for new chat sessions.
- `modelThinkingLevels`: optional map from `provider/modelId` to a thinking level. It takes priority over `thinkingLevel` for new
  conversations and is clamped to the levels the model supports.
- `maxTurns`: optional integer of 1 or more. A run may take this many tool rounds. The round that reaches the limit runs its tools,
  then the run ends unanswered and the session shows **Limit reached**. A new input starts a new run with a fresh count. It is not a time,
  token, cost, goal, or delegate-deadline limit and does not replace them. Unset means no limit. It applies to conversations created after the change.
  `subagents.maxTurns` and a profile's `maxTurns` set the limit for new children; without either, a child inherits its parent's limit.
  Scheduled (cron) runs and side questions do not use this setting. They keep their own run timeout.
- `afterFailedRun`: what happens to messages queued behind a response that failed. `keep` (default) leaves them queued until the next input,
  `continue` starts the next response with them, `withdraw` drops them. It applies to all sessions and live.
- Operator alerts: when `cron.notifyUrl` is set, storage failure (`storage_failed`) and tasks interrupted by the crash guard
  (`task_interrupted`, or an extension task's `task_faulted`) are also posted there. Pi 1.5 ends restart-limited work instead of parking it.
  `GET /v1/tasks/parked` and `POST /v1/tasks/:id/retry` return HTTP 410. They do not restart terminal tasks or repeat side effects.
  Inspect the session failure, then send a new input or request a new compaction when appropriate.
- `autoContinue`: resume a stopped turn after a rate or usage limit. `enabled` defaults to `false`.
  Edit it under **Settings → Chat → Continue after usage limits**. Changes apply live.
  Quota refusals have one retry owner: the durable continuation scheduler. Provider-local and generation retry
  loops do not rapidly retry a 429, even when automatic continuation is disabled. Non-quota transient network/server retries remain separate.
  Claude native preserves rejected SDK windows and upstream quota headers. Codex preserves HTTP headers,
  streamed `codex.rate_limits` windows, and refusal reset epochs. Google preserves allowlisted quota details and receipt time.
  These details stay in assistant diagnostics, not model-visible conversation text.
  For one quota window, an absolute `quotaResetTimeStamp` takes precedence over `quotaResetDelay`.
  Google `RetryInfo.retryDelay`, Retry-After guidance, reset epochs, ISO times, zoned clock times
  (such as "resets 1am (Asia/Amman)"), and relative text are also supported.
  Relative delays are anchored to the original response receipt time, never the request start or a later reload.
  Independent blocked windows and mandatory retry guidance remain lower bounds. Unknown windows prevent an exact-recovery claim.
  A known quota reset gets a 60-second safety margin, plus 0–30 seconds of positive jitter saved once.
  Without reliable future timing, delays are 2, 10, 30, then 60 minutes, bounded by the retry budget.
  Stale reset timestamps use fallback backoff, never immediate repeated requests.
  Sessions on the same configured provider/model route share cooldown evidence. Only one automatic recovery turn runs there at a time.
  The next waiting session starts after a safety interval. Different provider IDs are not assumed to share an account.
  Coordination is local to one daemon; it does not detect unknown shared accounts, aliases, or other daemon instances.
  `maxWaitHours` (default `168`) limits both an individual scheduled wait and the complete recovery lifetime from its first failure.
  `maxAttempts` (default `5`) limits admitted automatic continuations in that recovery chain.
  Neither budget resets after a daemon restart. A provider reset beyond the time limit leaves recovery paused, not shortened.
  Authentication, payment-required errors, empty balances, `insufficient_quota`, and context overflow never enter quota recovery.
  An upgrade suggestion with a recoverable quota reset is not, by itself, a permanent billing failure.
  New input, **Stop**, **Cancel**, a model change, archive/delete, a pending user action, or disabling recovery invalidates the old wait.
  Re-enabling recovery does not silently revive cancelled work. Cron runs, owned subagents, and side questions remain excluded.
  Recovery resumes the stored run with Pi's native `continue` submission. It adds no recovery message to the conversation, so the transcript
  and prompt-cache prefix stay unchanged. A continue is accepted only when the conversation is idle and its context ends in a user message or
  tool results; a busy or ineligible conversation is paused or retried by the rules above, never replaced by a synthetic user message.
  Because no input entry is added, the session's input boundary does not move; an admitted recovery shows no stale recovery state.
  Stable submission IDs and durable receipt lookup prevent duplicate continuation after an ambiguous acknowledgement or crash.
  Local delivery failures use three redelivery delays: 30 seconds, 2 minutes, and 10 minutes. Persistent failure then pauses recovery.
  Receipt lookups and redelivery of the same admitted input do not spend extra model-attempt budget.
  The existing wait status shows reported or estimated retry timing and the attempt budget. A reported reset does not confirm quota availability.
  Budget exhaustion and delivery failures show a pause reason. Waiting does not add recurring transcript messages or quota polls.
  Session detail/list responses keep `resumeAt` and add an optional `recovery` summary
  (`active`, `resumeAt`, `attempt`, `maxAttempts`, `exact`, `source`, `pausedReason`). Updates use existing SSE invalidation.
  Legacy waits without a failed-generation identity are retired. Identity-valid legacy waits retain their saved time;
  recovery pauses conservatively when its original lifetime or submission ownership cannot be established.
- `sessionTalk`: messages between sessions. `enabled` defaults to `true`; `maxHops` (1 through 20) defaults to `3`.
  Edit it under **Settings → Chat**. Changes apply live. See **Sessions talk with each other**.
- `providers`: custom AI endpoints, API formats, and model definitions. Built-in providers need no entry.
  Optional `compat` applies to every model of a provider and helps keep the prompt cache:
  `supportsMidConvoSystemMessages: true` sends a later system-prompt section update (board, skills, memory) as a
  message at its position, so the leading prompt and its cache stay fixed. Enable it only when the endpoint accepts
  system messages after the first user message; CLIProxyAPI does. `sendSessionAffinityHeaders: true` sends the
  conversation ID as `session_id`, `x-client-request-id`, and `x-session-affinity`, so a multi-account proxy with
  session affinity keeps one conversation on one upstream account. Claude CLI always sends section updates in place.
  `stableTools: true` keeps the declared tool list fixed for the whole conversation: tools that `tool_search` loads
  later are described as text, and the model calls them through `codemode`. Use it for endpoints that cache the tool
  list as part of the prompt prefix, such as Gemini through CLIProxyAPI, together with `supportsMidConvoSystemMessages`.
  It needs the `codemode` extension; without codemode the request does not change.
- `subagents`: optional `provider`, `model`, `thinkingLevel`, and `cwd` defaults, plus named `profiles`.
  Set both provider and model, or omit both to inherit the parent model. A selected profile can override provider/model and thinking.
  Profiles apply to new children only. Each profile has an exact `tools` allowlist, optional `instructions`, and `context` (`fresh` by default, or `fork`).
  An explicit `spawn.fork` overrides the profile context. Without a profile, children retain the parent's currently model-offered tools except delegation, board, and hidden questionnaires.
  New children omit the runtime's personal `identity` block (`SOUL.md`) and receive a neutral, task-focused role instruction.
  Parent and profile instructions still apply, including scope and approval requirements. Forked history remains task context, not the child's identity.
  This is a prompt-role boundary, not a file-access restriction. Existing children are not migrated; top-level sessions, including crew members, keep their identity.
  The built-in profiles are `scout`, `reviewer`, and `worker`. Scout and reviewer can read files, list directories with `delegate_files`, load existing skills with `skill` (`view` and `list` only; delegated children cannot change skills), and hand off; they have no shell or write tools.
  Worker can read, write, edit, run bash, load existing skills, and hand off. Profiles can select the parent's currently model-offered tools and enabled, model-callable deferred tools; profiles do not install tools or restore disabled tools.
  New children store their selected tools as a persistent ceiling. Skill loading and tool discovery cannot add tools outside it.
  The ceiling survives restart and forks, applies to nested tool calls, and is copied to background side tasks. Existing children are not migrated.
  Every selected tool is offered directly to the child, including deferred tools. The parent does not need to load `delegate_files` or other selected deferred tools first.
  The runtime adds `delegate_result` to every new child for result reporting. Tool restrictions are enforced by the native agent tool selection, not just instructions; they are not an operating-system sandbox.
  Supplying `profiles` replaces the profile map; omit it to keep the built-ins. Unknown profiles, duplicate tool names, incomplete model pairs, and unavailable selected tools fail explicitly.
  Child profiles cannot include `subagent`, `session_crew`, `ask_user_question`, `board`, or `tool_search`. Children cannot delegate further or lead a crew.

  `subagent` supports these actions:
  - `profiles`: list configured role defaults and tool allowlists.
  - `spawn`: start a child with `task`, optional `profile`, `fork`/`forkAt`, `worktree`/`base`, `notes`, `timeoutSec`, and `outputSchema`.
  - `steer`: send `task` to owned child `ids`. A new optional `timeoutSec` starts a fresh time budget; omitting it removes the old budget.
  - `wait`: collect owned child outcomes, validated results, and optional commit-object checks. `timeoutSec` here only bounds the wait (default 120 seconds, maximum 1800).
  - `list`: show owned child states, reasons, and task summaries.
  - `show`: show an owned child's pending handoff, recent tool calls, final response, and validated result.
  - `stop`: stop owned children. A stop remains final until explicit steering; steering is refused while the abort is still finishing.
  - `usage`: report parent, individual child, child-total, and combined model usage from existing per-conversation ledgers.

  Children have no `ask_user_question`. A child needing input or approval calls `session_status`; `wait` returns early and `list` shows the reason.
  A child's settled result, failure, or handoff sends one notification input to the spawning session, using a durable request ID to prevent duplicates.
  Notifications are admitted only when the parent is idle, using the installed guarded-input contract. Busy parents are checked again when their current input settles.
  The notifier subscribes before recovered work resumes and reconciles missed notifications on startup. Completed work is never executed again for notification recovery.
  Results already returned by a completed parent `wait` or `show` tool do not trigger another automatic parent turn; a collector that crashed before settlement is not counted as delivery.
  Stopped, archived, failed, quota-limited, or user-blocked parents are not automatically resumed, and parent-stopped children do not send routine completion messages.
  A child notice never clears a pending parent approval/input handoff or becomes an implicit retry after a parent failure.
  Held results can be delivered after the parent runs again. Existing pre-upgrade terminal children are not all replayed as new notifications; their handoffs still use the existing IDs.
  A peer message, result schema, receipt, or successful execution never grants approval or proves correct work.

  `spawn.worktree` creates a new branch under `.luna-worktrees` beside the repository. `base` is pinned to a commit after any requested remote fetch.
  Notes and the result schema are checked before allocation. Allocation intent is durable before branch/worktree creation, so a replay can reuse only its own matching allocation.
  Conflicting paths, branches, or uncertain partial allocations are preserved and reported, never deleted automatically. Remote execution-worker sessions do not support worktree allocation.
  Child submission identities live in the parent document; old records are migrated with complete own-entry pagination, not a first-page limit.
  Child time budgets use a native background task with durable sleep. They do not depend on `list`, `wait`, or a UI poll.
  Active pre-upgrade child deadlines are migrated to native deadline tasks on startup. Budgets survive daemon restart; completed, replaced, or stopped child deadlines are cancelled. The maximum budget is 2147483 seconds.

  `outputSchema` is a JSON Schema draft-07 object, at most 32 KiB and 32 nesting levels, with local references only.
  Its current value is available in the child's `delegate-result` prompt section, including after context compaction.
  The default receipt schema requires `commit_sha` (hex string or null), `pr_url` (string or null), `files_changed` (string array), and `blocked_on` (string or null), with no extra fields.
  Before its final summary, a child calls `delegate_result({ value: ... })`; values are limited to 64 KiB and checked against the schema before storage.
  Each result belongs to the current input boundary. Steering requires a new result; an earlier result cannot satisfy a later task.
  Invalid values return a tool error. A finished child with no valid current result is reported as failed, not successfully delivered.
  A valid schema is only data validation. A local commit check proves object existence only; remote-worker commits are not checked on the main host; PR URLs, changed-file claims, and validation claims remain unverified.
  Existing pre-upgrade children without a schema can still return their text and optional legacy receipt.

  `GET /v1/sessions/:id` includes child `profile`, `cwd`, and `resultStatus` (`valid`, `missing`, or `not_requested`).
  With children present, `delegationUsage` includes `parent`, `children`, `childTotal`, `total`, `unavailableChildren`, and an accounting note.
  Each usage summary contains token counters, `costUsd`, `missingCost`, and `zeroCostModels`.
  Totals include recorded model/compaction usage only. Tool-reported usage is not added because it can overlap; inherited fork history is not charged again.
  Deleted children are excluded and counted as unavailable. Recorded costs are estimates unless `costReported` is true; zero can mean unpriced, subscription, or free usage.
  The existing activity panel shows role, result-schema state, grouped recorded estimates, and the existing Open/Stop controls. There is no second inspector or usage store.
- `mcpServers`: stdio, HTTP, or SSE connections. `enabled: false` prevents connection.
  `defer` defaults to true. `timeoutMs` sets the tool-call timeout; the default is 600000 ms.
- `disabledTools`: tool names hidden from the model and refused if called. Applies to the next model request, including existing sessions.
- `disabledSkills`: skill names hidden from the skills catalog and `skill` `view`. Applies at once.
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

#### Cron endpoints

- `GET /v1/cron/reports`: list reports. Supports `history=1` (or `history=true`) to query historical superseded or read reports, or default inbox (newest unread report per job). Optional filters: `jobId` (positive integer), `limit` (integer 1..100, default 50).
  Pagination modes:
  - Default ID-descending order: uses `before=<id>` cursor.
  - Priority inbox order: `order=attention` (inbox only, errors first then newest ID). Paginates via opaque keyset cursor `cursor='0:<id>'` (for error rank) or `'1:<id>'` (for standard rank). Responses with `order=attention` include `nextCursor` (string or `null`).
- `POST /v1/cron/reports/read-all`: atomically marks all current unread inbox reports as read (`read_at = Date.now()`). Superseded historical reports remain unchanged. Returns `{ ok: true, count: number, unreadCount: 0 }`.

## Interactive replies

Assistant replies can include rich fences. The Web UI renders them in message order, alongside text and `MEDIA:` attachments:

- `ui`: one JSON object for a native chart (`line`, `area`, `bar`, `pie`, `donut`, optional `stacked`) or a slider plot.
- `mermaid`: a Mermaid diagram, rendered inline as sanitized SVG with the theme colors. Click it to open it full size.
- `math`: LaTeX, rendered with KaTeX (`trust: false`).
- `html`: a custom visual. See below.

There is a combined limit of four `ui` and `html` blocks per message. Extra blocks show their source and do not render.
A block renders only after its closing fence arrives. Use a `text` fence to show source without rendering.
Every block has a hover toolbar (always visible on touch screens): source view, copy, and expand or reload where they apply.

An `html` block takes one of two paths:

- **Inline (static):** markup without `<script>`, event-handler attributes, `javascript:` URLs, frames, objects, or form fields. It is sanitized with DOMPurify and rendered in a shadow root inside the chat. Remote URLs are removed from `src`, `href` (except `http(s):`/`mailto:` links, which open in a new tab), and CSS `url()`; `@import` is dropped. Only fragment and `data:image/` references stay. The host uses `contain: layout paint`, so `position: fixed` cannot cover the app. Styles that target `html`, `body`, or `:root` apply to the block root. Theme variables (`--foreground`, `--card`, `--chart-1`…) inherit into the block.
- **Sandbox (scripted):** anything else runs in the sandboxed iframe described below. The parent adds the theme variables and a dark color scheme (so the frame is transparent), and the frame reports its content height, so it grows to fit (40–1600 px).

`data-luna-prompt="text"` on any element, or `luna.prompt(text)` in a sandboxed script, puts the text in the composer on click. It is appended to an existing draft, never sent automatically. A sandbox request is accepted only during user activation.

`GET /html-preview` serves a public, stateless bootstrap document. It contains no transcript, token, or user HTML.
The shell signals readiness. The parent then sends only the block's HTML (with the theme and size helper added to its head) to that iframe, once per fresh shell. HTML is not stored or placed in a URL. An unresponsive shell shows a connection warning after ten seconds.
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

The agent calls one `web` tool with `action` `search` or `read`. Its name and parameters do not depend on the provider.

- `web action=search`: `query` and optional positive integer `count` (default `5`).
  Returns `{"results":[{"title":"...","url":"...","snippet":"..."}]}`.
- `web action=read`: an HTTP(S) `url` and optional `format` (`markdown` or `text`; default `markdown`).
  Returns `{"url":"...","content":"...","format":"markdown"}`.

Web results are untrusted data, not instructions. Provider failures return tool errors, not empty successful results.
URLs with embedded credentials and non-HTTP(S) protocols are rejected.
These tools are native and do not require `tool_search` discovery.

Choose each operation's provider in **Settings → Tools → Web tools**.
Both operations default to `disabled`.
Search providers: `searxng`, `freeserp`, and `ddgs`. The extract provider: `ddgs`.
The common tool interface accepts no provider options. Each adapter translates requests and normalizes results.
A new adapter implements `WebProvider` and is registered by the runtime, with its own validated configuration.
A search-only adapter omits `extract`.
The common tool implementation does not need to change.

`searchFallbacks` is an ordered list of search providers. When the selected provider fails or returns no results,
the next one is tried. When every provider fails, the tool error names each provider and its failure.
Fallbacks never apply when `searchProvider` is `disabled`, and never apply to extraction.

SearXNG calls `GET <url>/search?format=json`. The instance must list `json` under `search.formats` in its `settings.yml`.
Options: `url` (default `http://127.0.0.1:8888`), `safesearch` (`on`, `moderate`, `off`), and `timeoutMs` (default `15000`).
FreeSerp calls its keyless `GET <url>/api.php?index=web` endpoint. Options: `url` (default `https://freeserp.ai`) and `timeoutMs`.
Results with a non-HTTP(S) URL are dropped.

```json
{
  "web": {
    "searchProvider": "searxng",
    "searchFallbacks": ["freeserp", "ddgs"],
    "extractProvider": "ddgs"
  }
}
```

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
While a web setting (`searchProvider`, `searchFallbacks`, or `extractProvider`) selects DDGS, its MCP server stays connected as a provider backend only:
its `ddgs__*` tools are not given to the model, which uses the `web` tool instead. The MCP panel labels such a server "backend only".
DDGS options remain under `web.providers.ddgs`. Its proxy credentials, if needed, remain in the protected MCP environment (`DDGS_PROXY`).
Connection timeouts use the existing MCP `timeoutMs`. Cancellation reaches the same managed connection.
Saving applies web provider selection and option changes to the next tool call.
A disabled or disconnected selection fails explicitly. Search falls back only to providers listed in `searchFallbacks`.

Run `verify:web-tools` for deterministic runtime checks.
Run `verify:web-tools:live` to use the installed `/.local/bin/ddgs` against real web pages.
The live gate uses a scripted model; it verifies tool execution, not real-model tool choice.

## Skill management

The `skills` extension gives the agent one `skill` tool and the skills catalog. The `skill` tool also loads with the `improve` extension; there `view` is refused until `skills` is on.

- Only skills under `<dataDir>/skills` can change. Skills from `skillDirs` are read-only.
- `skill` actions: `view` (`name`, optional `file_path` for a linked file), `list`, `create`, `edit` (full content, or one exact `old_text` → `new_text`), `propose`,
  `rollback`, `delete`, `write_file`, `delete_file` (linked files, relative to the skill directory), and `restore`.
- `create` and `edit` are linted only. Use `propose` (`benchmark`, `benchmark_command`, or `must_contain`; optional `dry_run`)
  for a benchmark-gated change. Each edit backs up the previous `SKILL.md` for `rollback` (optional `version`).
- `delete`, `delete_file`, and a replaced linked file move to `<dataDir>/skills/.history/.trash`.
  `list` with `include_deleted` shows the ids; `restore` never overwrites an existing path.
- Delegated children and goal auditors can only `view` and `list`; every other action is refused there.
- Saved configs that still name a retired tool (`skill_view`, `skill_manage`, `web_search`, `web_extract`, `cron_history`,
  `vision_analyze`, `video_analyze`, `browser_tab`, `browser_inspect`, `process`) in `codemode.pinned`, `disabledTools`, or a subagent profile load with the new name.
  A retired name in `disabledTools` disables the whole merged tool.
- Linked-file paths stay in the skill's own directory: no `..`, no hidden parts, no symlinks,
  no `SKILL.md`, and no path inside a nested skill. A skill that contains nested skills cannot be deleted.
- Changes reach the prompt catalog on the next model call.

## Session learning

The `learn` extension captures contextual evidence without a background model call. A learning proposal is a
reviewable change, not a new authority to write. **All proposals require user approval.** No automatic-write
policy is enabled. The existing `memory`, file, and skill tools retain their separate permission scope;
this feature is not an OS sandbox around those tools.
The model-facing `lesson_signal` and `lesson_curate` tools were removed (zero calls in use); capture, review, and proposals run through the daemon and web UI.

### Capture and diagnosis

- `learn.captureEnabled` (default `true`) enables idle scanning after `learn.idleMinutes` (default `30`).
  Capture stores source pointers, a bounded redacted summary, preceding task/action pointers, loaded skills,
  and a normalized content fingerprint. Full transcripts stay in conversation storage.
- Compaction entries, background notices, peer messages, delegated conversations, and scheduled prompts are
  not independent user statements. Quoted blocks are excluded from rule matching. Message length is not a filter.
- Tool errors stay signals, not automatic lessons. A signal key is the tool, the program (for `bash`, the last
  command of the line, plus the subcommand for `git`, `gh`, `pm2`, `bun`, `pnpm`, `npm`, `cargo`, `systemctl`), and the
  normalized message. A bare exit code is its own cause, so `grep` exit 1 and `node` exit 1 never share a key.
  The failed call's arguments are stored in the signal context. Three kinds of failure create no signal: an
  expected result exit (exit 1 from `grep`, `rg`, `diff`, `cmp`, `test`, `git grep`, `pgrep`, or `git diff --quiet`),
  a stop signal (exit 130 or 143), and a harness interruption. Patterns from at least two conversations become
  visible for review. Legacy signals whose key ends in `:<harness>` stay in the ledger but are hidden from the
  queue. A later success from the same tool is only a recovery heuristic; it does not prove the same problem was fixed.
- Causes: `missing` (missing fact/procedure), `stale`, `not_loaded` (retrieval), `ignored` (available rule not followed),
  `wrong`, `conflict`, `project` (project-only knowledge), and `uncertain`. Ignored rules need a proposed code check,
  not more text. Conflicting and uncertain diagnoses cannot produce writes.

### Storage and write destinations

`learn.db` stores sources, assessments, observations, before/after change journals, and history. `memory.db`
stores facts and notes, plus keyed fact provenance and history. Both database files use mode `0600`.
Existing ledger records are retained, not reset.

| Scope | Destination and rule |
| --- | --- |
| `memory` | One global fact in `memory.db`; `fact` and stable `fact_key` are required. Versioned snapshots detect stale approvals. A `user.*` key requires an explicitly assessed user statement; inferences do not qualify. |
| `skill` | One managed `SKILL.md`; `skill` and complete `content` required. External skills remain read-only. Lint and a 1500-character growth budget apply. Retrieval fixes change the description. |
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

`critical` (review explanation). It saves a before/after snapshot and waits for the user. `must_contain` checks
text only; it is not behavioral verification. Proposals do not run shell commands or paid model benchmarks.
Skill learning rollback uses the learning journal, not the separate `skill` `rollback` version series.

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
- `memory { action: "forget" }` removes that fact's current memory, provenance, and memory history. Source transcripts and existing
  learning journals are separate records and are not purged by this action.

### Identity and user facts

`<dataDir>/SOUL.md` is the only identity file in the prompt. The runtime does not read `USER.md` or `MEMORY.md`.
Keep user preferences and other durable facts in `memory.db` (`memory` `save`, or a `memory` scope lesson). General
`save` updates clear old learning provenance rather than falsely attributing new content to an older source.

### Outcomes and cost

`success`, `failure`, or `unknown`. Assistant claims alone cannot establish success. The observation is bound to
an applied change and source timestamp. Repeated source content is deduplicated. Reported failures mark a change
`ineffective`; no observations means effect unknown. The user can verify a successful observation only while the
applied target still matches and no later failure contradicts it. This verifies that observation, not every future task.

counts. Use `offset` for pagination, `history: true` for closed lessons and legacy signals, or `lesson_id` for evidence, change journal,
and revision history. Legacy signals lack original-source fingerprints and stay outside the default queue.
Metrics include reported outcomes, observed lesson/session pairs, and review-due items.
They are not independent proof of improvement. Manual review usage remains in the host session's usage records.

The legacy `learn.schedule` field is accepted only for configuration compatibility. It no longer schedules a
model job. Startup and settings reconciliation disable the old `luna-learn` job without deleting its history.
No replacement job is created. Idle capture makes **zero model calls**; review occurs in a requested normal
session or after a relevant correction. There is no automatic replay evaluator or automatic policy promotion.

HTTP routes:
- `GET /v1/lessons`: active lessons, evidence, assessments, changes, observations, metrics, and `historyCount`.
- `GET /v1/lessons?history=1&offset=0&limit=20`: lightweight history summaries for rejected, retired, and replaced lessons. Returns `historyCount` and `nextOffset` (null at the end). Offset must be nonnegative; limit is bounded to 1–100. Evidence is loaded through the detail route.
- `GET /v1/lessons/:id`: full lesson detail, including evidence. The history panel fetches this on expansion.
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
The agent reads the source with its enabled tools (`web`, browser, `read`, shell).
It then creates or updates one managed skill with `skill`, which lints and backs up the previous version.
Use `skill` `rollback` to undo an update. External skills stay read-only; the agent creates a managed skill instead.
The skill lists its sources and marks each point as verified or assumed.
Sending `/learn` authorizes this one skill write; there is no separate approval step.

Source content is untrusted data. The instruction tells the agent to ignore any instructions in it.
This is a prompt rule, not a sandbox: the agent keeps its normal tool permissions during the turn.
Requires the `skills` extension. `bun test` checks it with a scripted model only.

## Planning interview

`/grill <plan, design, or topic>` interviews you about a plan until every decision is resolved. An empty argument returns usage.

The command becomes a normal turn. The agent asks one question per turn with `ask_user_question`, each with 2 to 4 options and a recommended option first.
It reads the codebase and files to answer what it can instead of asking, and it challenges weak answers.
It does not implement anything. When no decision remains, or you say stop, it writes the plan (goal, decisions with reasons, open risks, ordered steps with verification) to `/.luna/plans/<yyyy-mm-dd>-<slug>.md` and reports the path.

## Crafting a skill

`/skillcraft <skill idea or existing skill name>` interviews you and then saves one managed skill. An empty argument returns usage.
The command becomes a normal turn in the current chat. The agent runs `skill` `list` first and plans an update if a managed skill already covers the topic.
It asks one question per turn with `ask_user_question`, in this order: trigger, scope and non-goals, procedure, gates, pitfalls, tools, reference files.
It then shows the full draft `SKILL.md` and asks for approval. Only after you approve does it write with `skill`, which lints and backs up the previous version.
Use `skill` `rollback` to undo an update. External skills stay read-only. Requires the `skills` extension.

## Native browser tools

The agent uses these provider-neutral tools without `tool_search` discovery:

| Tool | `action` | Parameters | Result |
| --- | --- | --- | --- |
| `browser` | `open` | `url` | `tabId`, current `url` |
| `browser` | `navigate` | `tabId`, `url` | `tabId`, current `url` |
| `browser` | `close` | `tabId` | `tabId`, `closed: true` |
| `browser` | `snapshot` | `tabId`, optional `offset` | `tabId`, `url`, `content`, `hasMore`, optional `nextOffset` and `totalChars`; image when available |
| `browser` | `screenshot` | `tabId` | `tabId` and a viewport image block |
| `browser_act` | `click` | `tabId`, exactly one `ref` or `selector` | `tabId`, `ok: true` |
| `browser_act` | `type` | `tabId`, exactly one `ref` or `selector`, `text`, optional `pressEnter` | `tabId`, `ok: true` |
| `browser_act` | `scroll` | `tabId`, `direction`, optional `amount` | `tabId`, `ok: true` |

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
Three browser providers are included: `camofox`, `moli`, and `chromium`. `camofox` reuses a named, enabled MCP connection:

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
`moli` starts the [Moli](https://github.com/lexmount/moli) binary on a private loopback port (layout and images on, child gets only `PATH`, `HOME`, `LANG`), drives it over CDP with Playwright, and stops it when the provider closes. Options: `browser.providers.moli.executablePath` (required) and `profileDir` (optional, keeps cookies and storage).
Moli builds layout on demand, so Luna renders a 1x1 image before snapshots, clicks, typing, and scrolling so elements get refs and real geometry. Moli does not play video or match Chrome pixel-for-pixel.
`chromium` launches a local Chromium-based browser such as Helium through Playwright, on the machine where Luna code runs (main, or a worker).
It needs `browser.providers.chromium.executablePath` and `bun install` on that machine. `headless` defaults to true.
Tabs share one browser context. Snapshots use Playwright's accessibility snapshot, and refs work with `browser_act` `click` and `type`.

Provider options stay under `browser.providers.<provider>`. Connection settings and credentials stay in the existing MCP configuration.
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
Claude Code CLI. The transport runs inside the daemon; it does not require Python or a separate agent installation.
New conversations use the `luna` MCP namespace. Legacy signed replay retains its original namespace without rewriting signed messages.
`LUNA_CLAUDE_EXECUTABLE` selects the Claude executable. Otherwise Luna searches for `claude` on PATH,
then the usual installation directories, including `~/.local/bin`.
Use `claude auth login`, `CLAUDE_CODE_OAUTH_TOKEN`, or `CLAUDE_CONFIG_DIR` for authentication.
Provider availability checks `claude auth status`, not just the executable's presence. The check sends no
model prompt, has a ten-second timeout, and terminates its owned process group on cancellation or timeout.
Readiness, model discovery, usage reports, and generations share executable selection and environment guards.
Conflicting API keys, custom Anthropic endpoints, and Bedrock/Vertex/Foundry overrides block requests.
The provider does not silently change to API billing or another model.

Paid usage credits are disabled in Luna by default. If Claude reports that a response used overage,
Luna records its completed generation's tokens and native cost, then stops with a non-retryable billing error.
It does not execute that response's tools or automatically continue. This is a reactive guard: that first
response may already be charged. Disable extra usage in Claude account settings to prevent the first charge.
To permit paid overage intentionally, set `LUNA_CLAUDE_ALLOW_USAGE_CREDITS=1` in the daemon environment.
The values `true`, `yes`, and `on` also enable it. Other values leave the guard active. Upstream requests
that demand usage credits produce a billing error instead of an automatic retry.

Models use the installed Anthropic catalog's reasoning support and thinking-level map. The existing
thinking selector controls adaptive effort on supported models and token-budget thinking on older models.
Turning thinking off disables it explicitly where the model supports off. Requests are clamped to the model's
supported levels; models that require thinking use their lowest supported level instead.
Unknown models do not advertise unsupported reasoning features.

Luna replays separate native user, assistant, tool-use, and tool-result frames.
It no longer embeds the conversation as a JSON string in one user prompt.
Signed native assistant blocks are retained for unchanged responses from this provider and model.
A request-scoped local relay permits at most one upstream Messages request.
The relay keeps cache markers on recurring content, not on Claude's per-request context.
This preserves reusable message prefixes; it does not guarantee vendor cache hits or quota savings.

On models with catalogued native system-message and tool-change support, the initial tool list stays fixed.
Later additions, removals, and same-name redefinitions are sent chronologically at assistant boundaries,
using native inline tool blocks and the matching beta header. This avoids changing the initial tool prefix
when deferred tools become available. Unsupported models, or histories without an initial active tool,
use the current tool inventory instead. Only currently offered tools can execute, regardless of history.
Each generation still starts a fresh CLI process. Warm-process reuse is not enabled.
Tools hidden by settings or unavailable vision/video routes are omitted from both historical additions
and removals in the outgoing request. Stored conversation history and tool selections remain unchanged.
This prevents native replay from removing a tool that the request never declared.

Luna executes all tools. Claude receives an inert tool inventory and cannot execute Luna tools.
Luna supplies actual host results on the next request. Claude's temporary transcript is not resumed.
A tool-result mismatch blocks forwarding instead of accepting a synthetic denial.
Only a complete, validated response can return actionable tool calls.
Known long-context models route to their native `[1m]` variant and report 1000000 tokens.
Explicit `[1m]` routes also report 1000000 tokens. Other routes report a conservative 200000-token window.
The adapter has no input-size guard. The runtime's context-window compaction limits history size.

Each completed generation records Claude Code's `total_cost_usd` estimate in the assistant usage and the conversation's existing usage ledger. The transport reads the final result once; history replay acknowledgments are not added. Each process starts without resuming saved costs and permits one queried generation. Tool-use/max-turn and handled refusal completions use the same cost path. A missing, negative, or non-finite native cost fails response validation instead of silently recording zero.

`/usage`, `/cost`, and analytics read this recorded total. It is Claude Code's USD estimate, not a subscription bill or a local catalog-price calculation. Claude Code does not supply per-token-category dollar amounts, so component cost fields remain zero; the reported total is authoritative. Older zero-cost entries are not backfilled. Existing conversations start accumulating cost only for generations run with this fix; previous totals remain incomplete.

### Verification

Run `bun run typecheck` for backend changes. This repository does not include the historical
`verify:claude-cli:*` scripts. Compiler success does not prove live vendor behavior or cache savings.
Authenticated model generations consume account quota and require separate approval.

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
LUNA_PLAYWRIGHT_PATH=/path/to/playwright bun run verify:settings-ui
```

Also run `verify:settings-page-ui` to check full-page navigation, tabs, drafts, deep links, mobile layout, and error recovery.
Both tests use isolated config files, databases, and a faux model. They do not call an external AI provider.

## OpenAI Codex subscription

The built-in **OpenAI Codex** provider (`openai-codex`) uses the ChatGPT Codex login and
`https://chatgpt.com/backend-api`. It uses the Codex plan quota, the same quota as the Codex app and CLI.
The **OpenAI** provider (`openai`) uses Sign in with ChatGPT token sharing on `https://api.openai.com/v1`.
That path has a separate "Subscription Sharing" usage limit. A Codex reset does not reset it.

Log in from Settings → Providers → OpenAI Codex. Select browser login, or device code login on a headless host.
The credential is stored in `auth.json` under `openai-codex`. Luna does not read or change `~/.codex/auth.json`
for chat, so the Codex CLI login and its refresh token stay independent.

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

Luna applies absolute token thresholds to every session, including existing sessions, cron runs, crew members, and delegates.
Configure them in `luna.config.json` (or through the shared settings API):

```json
"compaction": {
  "sessions": { "backgroundAtTokens": 120000, "blockAtTokens": 160000, "keepRecentTokens": 20000 },
  "subagents": { "backgroundAtTokens": 80000, "blockAtTokens": 120000, "keepRecentTokens": 20000 }
}
```

These are the defaults. Partial overrides are accepted. All values must be positive integers, with
`keepRecentTokens < backgroundAtTokens < blockAtTokens`. Settings apply on the next preparation or compaction selection;
an already-running model request is not interrupted. Delegates use `subagents`; ordinary sessions, crew members,
and cron runs use `sessions`. Delegate identity is read from durable result-schema state, including after compaction or restart.

At the background threshold, summarization starts without delaying the current turn. At the blocking threshold,
the next model request waits for blocking compaction. Thresholds use estimated active context tokens, not cumulative usage.
They are preparation-time triggers, not a byte-level hard cap: a large input or tool result can cross them in one step.
Compaction needs an eligible older prefix; if none exists, it cannot shrink the context. No messages are silently truncated.

The smaller model-capacity safety thresholds still take precedence: reserve 16384 tokens for the answer,
and start background compaction 32768 tokens before that safety limit. The summary retains approximately
`keepRecentTokens` of recent history verbatim, plus a summary of older history. Emergency context-overflow recovery remains enabled.
The local `pi-durable` patch adds absolute thresholds and live host policy resolution; the dependency still owns
summary generation, placement, recovery, cancellation, and persistence. Compaction does not reset cumulative token usage.

## Messages sent during a turn

```json
"busyInput": { "mode": "interrupt", "acknowledgements": true }
```

Change these fields in **Settings → Busy chat input**. Both apply immediately, including to existing sessions.

- `interrupt` (default): redirect an active model request. Keep partial text and finished work. During tools, steer instead.
- `steer`: add text after the tool batch. Multiple pending steers form one user message, separated by newlines. Check again before ending a turn.
- `queue`: run each message as a separate later turn, in order. Do not combine message boundaries.

File attachments always queue. Text transcripts use the text policy. Interrupt mode falls back to queue during compression or active subagents.
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

`/usage` (alias `/cost`) returns recorded model token totals and cost for the current Luna conversation, plus Claude plan usage from the daemon host's Claude Code login. It does not submit a model prompt, change the conversation, or scan local transcripts. Tool-reported usage is excluded because it can overlap model usage. Recorded model cost is not the subscription bill; Claude generations record the native CLI's USD estimate, while providers that do not report cost can show zero.

**Cost source labels.** A cost total is *provider-reported* only when the provider returned the billed amount (for example OpenRouter) for every priced response in the sum. The flag is `usage.cost.totalFromProvider`. A sum with any catalog-rate, Claude CLI estimate, mixed, or unflagged part is an estimate, never an invoice. A missing flag counts as unknown, not billed. The pi-durable patch combines the flag when the session ledger adds responses, because stock 1.5 keeps the first response's flag. Analytics, the status bar, `/usage`, and the delegation summary (`costReported`) show the source. Component costs (`input`, `output`, and so on) stay catalog estimates even when the total is provider-reported. Claude Code's total is its own USD estimate and is not marked provider-reported. Older ledger entries have no flag and read as estimates. The report appears in command feedback, not model context.

Claude plan data uses the experimental Claude Code `get_usage` control API. It includes available usage windows, reset times (UTC), and extra-usage utilization. Missing limits display as unavailable, never as zero. Unsupported CLI versions, login failures, and timeouts preserve Luna's session totals with an error notice. Requests have a 20-second timeout and terminate their child process group. Executable selection and OAuth-only environment validation follow the Claude native transport, including `LUNA_CLAUDE_EXECUTABLE` and `CLAUDE_CONFIG_DIR`. Remote-worker sessions still report the **daemon host's** Claude account, not the worker's account. No new configuration fields are required.

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
The model receives its process ID and can use the `process_manage` tool to list, read, wait for, or stop it. Handles belong to their chat session.
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

### Active session workspace

`session_worktree { "action": "switch", "path": "/absolute/directory" }` explicitly activates an existing directory on the session's current machine. Use it when moving work into a worktree that already exists. Creating a worktree with another tool, inspecting a file, or passing a shell command an explicit directory does not activate it. `session_worktree` was `session_workspace` before; saved configs that name the old tool get the new name.

### Auto-worktree

A named project can set `autoWorktree: true` (`PATCH /v1/projects/:id`, or the Worktrees section of the project panel; default `false`). The session's first `edit` or `write` inside the project's main checkout is then refused with a pointer to `session_worktree`. That tool fetches `origin`, cuts `luna/s<id>-<title-slug>` from origin's default branch into `<repo parent>/.luna-worktrees/<repo>-s<id>`, runs the project's optional `worktreeSetup` command there, and switches the session into it. It runs through the session's own environment, so it works on workers. Afterwards absolute `edit`/`write` paths into the main checkout map to the worktree. Sessions that only read or answer never allocate one, and writes outside the checkout (for example generated files) are not refused. A fork starts without a worktree and allocates its own.

`session_worktree { "action": "finish" }` removes the worktree and branch and returns the session to the main checkout. It refuses while the tree has uncommitted changes or the branch tip is neither in origin's default branch nor the head of a merged GitHub PR (`gh`). Nothing detects the merge by itself: the model runs `finish` after the merge. On host sessions, a `bash` call that changes the main checkout before a worktree exists adds a warning to its result; worker sessions have no such guard.

The workspace uses the session's persisted agent `cwd`; there is no second workspace setting. Subsequent default file and shell paths, file completion, the Git status widget, and session-scoped Source Control operations use it. The UI receives the existing `agent_changed` event and refreshes without a reload. Call the switch separately before other work. Already-running commands keep their original directories. The tool does not change the project, execution machine, or any other session. Invalid or unavailable directories fail without changing the workspace. Recovered calls do not reapply an earlier switch.

The existing `PUT /v1/sessions/:id/machine` route remains the user-facing way to set a directory or move an idle session to another machine.

### Session messages

The `session_send { to, message }` tool sends a message to another session:

- An idle target starts a new turn. A busy target queues the message as follow-up input. It never interrupts.
- The message starts with a header that names the sender and says it is a peer session, not the user.
  The header tells the target to reply only when the reply is useful, and never with acknowledgements or thanks.
  A peer message grants no permission: merge, publish, and delete still need the user.
- The delivered input is a `luna.xsession.msg` entry with `{ from, hop, requestId }` metadata, plus `approvedMaxHops` when the user has extended its limit.
  Queued messages do not change the active exchange before delivery.
  The request ID is `xsession:<sender>:<taskId>`, so a replayed tool call delivers once.
- Each reply in an exchange increases the hop count. A send after `maxHops` is refused.
  A new user message in the sending session starts a new exchange at hop 1.
- A hop-limit error has an **Allow N more messages** button. N is the configured `sessionTalk.maxHops`.
  It extends only that exchange, keeps the default setting unchanged, and asks the sender to retry.
  The approved limit travels with subsequent peer replies and survives daemon restarts.
  New human input, a context reset, or a fork starts without the previous approval.
  Repeated approval requests do not add another block or submit another retry input.
- `GET /v1/sessions/:id/exchanges/:to` returns `{ to, anchor, hop, maxHops, approvedMaxHops, enabled, increment }` for the current exchange.
  `POST /v1/sessions/:id/exchanges/:to/extend` accepts `{ anchor, maxHops }` from that status or the blocked tool result.
  It returns the updated state plus `requestId`. A stale, disabled, or non-blocked exchange returns 409.
  The endpoint uses the normal API authentication; agents have no tool to grant themselves more messages.
  Approval is not permission to merge, publish, or delete.
- Refused targets: the same session, unknown or deleted sessions, subagents (use `subagent`),
  and conversations owned by another session's task.
- The tool returns at once. A reply, if any, arrives later as a new message from the peer.

In the transcript, a received peer message shows a **From #<id> <title>** chip in place of the header.
The chip opens the sending session. A typed header without metadata on that exact input is shown as plain text.

### Session crews

The `session_crew` tool lets a session lead a crew of full sessions. It is part of the `delegate` built-in extension.
A crew member is a normal top-level session, not a subagent: it has every tool, shows in the sidebar, and the user can talk to it directly.
Subagents (`subagent` children) and task-owned conversations cannot lead a crew.

Actions:
- `options`: projects with their machine directories, machines (main host and execution workers, with online state), thinking levels, the default model, and the lead's own model.
- `create`: start a session with `task` and optional `title`, `project` (0 = General), `machine` (worker id; absent = main host), `model` (`provider/modelId`), `thinkingLevel`, `cwd`, `instructions`, `worktree`, `base`, and `notes`.
  The rules are the same as `POST /v1/sessions`: a named project must be linked to the selected machine, `cwd` overrides the project directory, and unknown workers, projects, models, or thinking levels fail.
  `worktree` names a new branch. The member works in its own git worktree of the project directory (or `cwd`), made from `base` (default `HEAD`; a remote base is fetched first). It uses the same allocation as `subagent` and works on the main host only. Dependencies such as `node_modules` are not installed in the new worktree.
  `notes` is a file path on the main host. Its first 8000 characters go before the task in the member's first message.
- `send`: give member `ids` a new task, a review, a correction, or a retry. A busy member gets it after its current turn; `interrupt: true` steers it now.
  Optional `model` and `thinkingLevel` switch the member before the message, for example after a quota error. The change applies from the member's next model request.
  A failed member continues in the same session with its full context.
- `wait`: block until the members finish or one is blocked. Without `ids` it waits for running members and also returns settled results the lead has not seen yet (not collected and not delivered as a report). `timeoutSec` defaults to 300, maximum 1800.
- `show`: a member's state, pending question, full error text, and full final answer. `list`: every member with its state and task. `stop`: abort members.

A failed or unanswered member shows an error class and one short line (the provider's `message` field or the first line of the error):
`quota` (a rate or usage limit; the reset time is shown when the error names one), `transient` (network drop or abort; send `continue`),
`fatal` (auth, billing, or context size), `deleted` (the session no longer exists), and `error` (anything else).

Messages from the lead are `luna.xsession.msg` inputs with a header that names the lead. The header grants no permission.
The member's prompt gets a **crew** section that names its lead. Only lead messages count as crew tasks; turns the user starts directly in the member do not.
When a member settles the lead's latest task (done, failed, unanswered, or blocked on approval or input), the lead receives one automatic report with the final answer.
Reports use durable request IDs and the same guarded delivery as subagent notifications.
Active sessions receive reports at the next safe model boundary, after current tools finish, without waiting for a final answer.
Idle sessions resume automatically. Stopped, failed, input-blocked, approval-blocked, and limit-reached sessions are not resumed by crew or subagent reports.
A report already collected with `wait` or `show` is not sent again.
Missed reports are reconciled on startup. Stopped members and archived leads get no automatic reports.
A lead and its members can use `session_send` in both directions without a hop limit.
A lead's `session_send` to its own member counts as a crew task, the same as `send`: its answer is what `wait`, `show`, and the automatic report return.
Lead and member links do not pass to forks. Deleting a lead does not delete its members.

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

- `bash({command, timeout?, background: true})` starts a shell command and immediately returns a managed process ID.
  It runs in the calling conversation's working directory; use `cd dir && …` for another one.
  An optional positive `timeout` limits command execution. Spawn failures become failed process results.
  With the setting off, `background: true` is refused; foreground `bash` is unchanged.
- `process_manage({action, id?, timeoutSec?, offset?, limit?})` with `list`, `read`, `wait`, or `stop` manages only the calling
  conversation's processes, including foreground commands that moved to the background. Every action except `list` requires an ID.
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

Completion submits one result to the owning conversation and resumes Luna automatically.
An active run receives it at the next safe model boundary, after current tools finish, without waiting for a final answer.
Delivery does not cancel the current tool. The result includes a bounded output tail.
Shell output is untrusted data. Pending delivery survives restart and uses a stable request ID to prevent duplicate submissions.
If `cron.notifyUrl` is set, an external completion notification carries status only, not shell output.
Closing a viewer or stopping the conversation does not stop an admitted background process.

On POSIX hosts, `stop` and normal daemon shutdown kill each running command's process group and wait for execution to settle.
Execution completes when the launched command or shell exits. Do not append `&`; `bash` with `background: true` already runs in the background.
Children that outlive that shell are no longer managed after its completion.
Descendants that create another process group or session can also escape this termination boundary.
Normal shutdown retains stopped results. After an abrupt daemon failure, unfinished saved jobs become `interrupted`.
The daemon does not reattach to or restart those commands. Surviving OS processes may still run after a crash.
An interrupted result does not prove that the old command stopped. Inspect the host before repeating destructive commands.
Saved output and completed exit codes remain available after restart until retention expires.

Run `bun test` for real shell execution through the native runtime tools.
The test uses a scripted model; it does not prove real-model tool choice.

## Webhooks

Luna receives webhooks from other services and sends its own events out. State lives in `<dataDir>/webhooks.db` (mode 600).
The receiver always runs. The `webhooks` extension controls only the agent tools: `webhook_list`, `webhook_create`,
`webhook_update`, `webhook_remove`, `webhook_test` and `webhook_log`. The tools never return secrets.

### Inbound

Each inbound hook has a random URL, `POST /hooks/<slug>`, and its own secret (`whsec_…`). This route is outside `/v1`,
so the daemon token does not apply; the hook secret protects it. The sender must reach the daemon (LAN, Tailscale, or a public HTTPS address).

- `verify: "hmac"` (default): the request carries `sha256=<hex HMAC-SHA256 of the raw body>` in `X-Hub-Signature-256`
  (GitHub), `X-Signature-256`, `X-Luna-Signature` or `X-Signature`.
- `verify: "token"`: the secret in `Authorization: Bearer`, `X-Webhook-Token`, `X-Gitlab-Token` or `?token=`.
- Target: `{ "kind": "session", "id": N }` sends the payload to that session as input. `{ "kind": "project", "id": N }`
  creates a new session in project N per call (`0` is General), titled `<hook name>: <event>`. `{ "kind": "cron", "id": N }` runs that job now.
- `events`: optional filter. The event comes from `X-GitHub-Event`, `X-Gitlab-Event`, `X-Luna-Event`, `X-Event-Type`, or the body's
  `type`/`event` field. `pull_request` matches all actions, `pull_request.opened` one action (the body's `action`), `issues.*` a prefix.
  Other events answer 202 `{ ignored: true }`.
- `template`: optional text for the session input. Placeholders: `{{body.path.to.field}}`, `{{headers.x-github-event}}`, `{{event}}`,
  `{{action}}`, `{{delivery}}`, `{{hook}}`, `{{payload}}` (the whole body). Without a template the input is the formatted body.
  Every input starts with a line that names the hook and says the payload is untrusted data.
- Dedupe: a repeated `X-GitHub-Delivery`, `X-Gitlab-Event-UUID`, `X-Luna-Delivery`, `Webhook-Id`, `X-Delivery-Id` or `X-Request-Id`
  answers 200 `{ duplicate: true }` and does not run again. The id is claimed before dispatch, so a concurrent repeat
  answers 409 and does not run either. A rejected or failed attempt frees the id for a retry. Accepted and ignored ids are kept
  30 days, separately from the call log.
- Limits: 1 MB body (413), 60 requests per minute per hook (429). GitHub `ping` answers 200.
- Responses: 202 accepted (`sessionId` or `runId`), 401 bad signature, 404 unknown or disabled hook, 409 same delivery in progress, 410 target session deleted.
- Each hook keeps its last 100 calls with the outcome: `delivered`, `ignored`, `duplicate`, `rejected` or `failed`.

The older `POST /v1/webhooks/:sessionId` route (daemon token, no per-hook secret) still works.

### Outbound

A subscription sends matching events to a URL. Events: `session.finished`, `session.review_finished`, `session.needs_input`,
`session.needs_approval`, `session.failed`, `session.limit_reached`, `cron.run.ok`, `cron.run.failed`. A filter may use `session.*`,
`cron.*` or `*`; an empty filter receives all. Session events follow the same rules as push: a session that was running stops or asks
for the user. Subagent and archived sessions send none; cron sessions send only `session.failed`.

- Formats: `json` (the envelope below), `ntfy` (plain text with a `Title` header), `discord` (`content`), `slack` (`text`).
- Every request carries `X-Luna-Event`, `X-Luna-Delivery` (the event id, stable across retries), `X-Luna-Timestamp` and
  `X-Luna-Signature: sha256=<hex HMAC-SHA256 of the body with the subscription secret>`.
- JSON envelope: `{ "id": "evt_…", "event": "session.failed", "createdAt": "<ISO time>", "data": { "title", "text", "sessionId", ... } }`.
- Delivery: a durable outbox. A 2xx is success. Other answers and network errors retry after 30 s, 2 min, 10 min, 1 h and 6 h, then
  the delivery fails. `410 Gone` fails it at once. Pending deliveries survive a restart. Finished deliveries are kept 7 days; cleanup runs hourly.
- Redirects are not followed. The request times out after 10 s.

### Webhook endpoints

All need the daemon token. Secrets appear only in the create, rotate and `secret` responses.

- `GET|POST /v1/webhooks/inbound`, `PATCH|DELETE /v1/webhooks/inbound/:id`: list, create (`name`, `target`, `verify`, `template`,
  `events`), change (also `enabled`), delete. Responses include `path` (`/hooks/<slug>`).
- `POST /v1/webhooks/inbound/:id/rotate`, `GET /v1/webhooks/inbound/:id/secret`, `GET /v1/webhooks/inbound/:id/log`.
- `GET|POST /v1/webhooks/outbound`, `PATCH|DELETE /v1/webhooks/outbound/:id`: subscriptions (`name`, `url`, `events`, `format`, `enabled`).
- `POST /v1/webhooks/outbound/:id/rotate`, `GET /v1/webhooks/outbound/:id/secret`.
- `POST /v1/webhooks/outbound/:id/test` queues a `webhook.test` event (filter ignored). `GET /v1/webhooks/outbound/:id/deliveries`
  lists attempts. `POST /v1/webhooks/deliveries/:id/redeliver` sends one again with a fresh retry budget.

## Code Mode

Enable or configure Code Mode under **Settings → Tools → Code Mode**:

```json
"codemode": {
  "timeoutMs": 300000,
  "memoryLimitBytes": 134217728,
  "inlineBudget": 3000,
  "pinned": ["bash", "read", "edit", "write", "todo", "board", "worker_exec", "process_manage", "web", "browser", "browser_act", "subagent", "skill"]
}
```

To make the `codemode` tool available to sessions, include `"codemode"` in `extensions`. The default configuration enables `codemode` automatically when `extensions` is omitted. If an explicit `extensions` list is defined in `luna.config.json`, `"codemode"` must be explicitly added to that list.

Changes to `codemode` require a daemon restart.

- `timeoutMs`: Overall execution deadline in milliseconds (default `300000`, 5 minutes) enforced at the execute boundary. Individual scripts may specify a shorter deadline via `// @options: {"timeout_ms": ...}` on the first line; requests exceeding `timeoutMs` are clamped to this hard ceiling. Durable replay journals persist this effective deadline.
- `memoryLimitBytes`: Maximum memory the QuickJS WebAssembly VM may allocate per script (default `134217728` bytes / 128 MiB). Allocations beyond this fail with an out-of-memory error inside the script. This does not limit memory allocated by external tools called from the script.
- `inlineBudget`: Estimated token budget (default `3000`) for tool declarations rendered in the `codemode` prompt section.
- `pinned`: Tools whose declarations the `codemode` section always lists first, in this order, when the session can call them. Their cost counts against `inlineBudget`; the rest of the budget lists the cheapest other tools. Scripts find unlisted tools with `searchTools()`. Without pins, the cheapest declarations fill the budget and long core tools such as `bash` and `read` drop out.

The `codemode` section also tells the model when to choose Code Mode: when it can write the complete plan before it sees a result (a chain where each call feeds the next, the same call for many inputs, or large output to filter). A single call, an edit, or a step that depends on reading a result stays a direct call, and an unknown output shape gets one direct call first. When the session can call both `bash` and `read`, the section also shows one short example script.

Luna writes the `codemode` tool description itself (`codemodeToolDescription` in `src/codemode.ts`) instead of using Pi's text. It states the effective `timeoutMs`, the rule that `store()` writes are saved only when the script succeeds, and that scripts can call deferred and unlisted tools. It does not mention namespaces or `models.*`, which Luna does not configure.

Direct tools remain available. Code Mode is useful for multi-step tool workflows and filtering intermediate results before sending a summary to the model. For example:

```javascript
const results = await Promise.all(["package.json", "AGENTS.md"].map(path => tools.read({ path })));
for (let i = 0; i < results.length; i++) text(results[i]);
```

Nested calls use the session's existing permissions, disabled-tool checks, and target execution machine. The JavaScript VM runs on the daemon; file and shell tools still run on the session's selected machine. Default subagent profiles do not gain Code Mode automatically. To use it in a custom profile, include `codemode` and each required nested tool in that profile's tool allowlist. Scripts cannot call Code Mode recursively.

The built-in `models.*` helpers are disabled. Use Luna's existing image and analysis tools instead. The chat tool card shows script source, output, and saved nested-call status after reload. Restart recovery follows each nested tool's replay policy; it does not make arbitrary external effects exactly-once.

The `codemode` tool executes model-written JavaScript in an isolated QuickJS sandbox via `@earendil-works/pi-codemode` and `@earendil-works/pi-durable/codemode`. Scripts call existing tools via `await tools.<name>(args)`. The sandbox does not expose Node APIs, network sockets, or filesystem access. On daemon shutdown, active sandboxes close before the harness to preserve clean state and permit durable replay resume.

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
Uploaded image previews go to the new conversation. File metadata and execution-machine paths are preserved for all attachment types.
Audio understanding requires an enabled tool that can read or transcribe those files; it is not a native audio model input.
Normal messages can also contain audio as a persistent file attachment. `/btw` and `/review` reject new attachments.

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
- **Generate title** in the session menu replaces the current title on request, using all user messages in chronological order
  and current details of their board references. It names the current main task, including later changes of direction.
  Unlike automatic naming, it does not limit message text to the opening 1,000 characters.
  It is unavailable without a route. Automatic naming behavior is unchanged.
- `session_search` shows stored titles (renames and generated titles) instead of the first message.
- `session_search` shows each session's live status. Its `status` parameter (one value or a list: `ready`, `running`, `reviewing`, `review_finished`, `finished`,
  `needs_approval`, `needs_input`, `limit_reached`, `failed`, `stopped`) keeps only matching sessions, alone or with `query`.
  `failed`, `limit_reached`, `needs_*` and `stopped` results include the reason (the error text for failures). A status filter
  checks the newest 300 sessions and returns up to 50 results.

## Keyboard navigation

- Press **Tab** in an unfocused chat to focus the message input. Existing controls keep their normal tab order.
- Use **Tab / Shift+Tab** to move between controls. Keyboard focus has a visible outline.
- Use **Enter / Space** on buttons. Use arrow keys in menus, suggestions, model lists, and tab bars.
- Press **Escape** to close the topmost menu or dialog and return focus to its trigger. Escape never stops a response.
- Press **Ctrl+K** (**Cmd+K** on macOS) for the command palette: navigation, conversations, models, and settings.
- On desktop, **Enter** sends a message and **Shift+Enter** adds a line. Suggestions take Enter or Tab while open.
- Open a board card with its title button. Use its status selector to move it without dragging.
- Focus an image preview and press **Enter / Space** to open it. The viewer supports the same keys to change zoom.
- In split view, tab to the divider controls. Swap tiles with the button; use arrow keys to resize, or Enter/Space to reset.

## User terminal

An interactive shell in a bottom dock of the web UI, drawn by ghostty-web and backed by `Bun.Terminal`. It is off by default.

- `terminal.user` (boolean, default `false`): allow user terminals. Settings > Tools > Terminal. It is read live and enforced at the WebSocket upgrade, so turning it off stops new attaches without a restart.
- Open the dock with the header button, **Ctrl+\`**, or "Show terminal" in the command palette. A session can run up to 8 terminals at once.
- The shell is the daemon's `$SHELL` as a login shell (`-l`), or `/bin/sh` when `$SHELL` is unset or missing. The environment has `TERM=xterm-256color` and `COLORTERM=truecolor`. `LUNA_TOKEN` and `LUNA_WORKER_TOKEN` are removed. On a worker machine the worker picks its own shell from its own environment.
- A terminal belongs to its session. It survives closing the dock or the browser tab, keeps the last 2 MB of output, and replays it on re-attach. It closes when the session is deleted or the daemon stops. A session on a worker machine runs its terminals on that machine; if the worker goes offline they end with the reason. Workers older than this feature report no `pty` capability, and the terminal says to update and restart them.
- Anyone with the API token can open a shell as the daemon's user. Enable it only on a daemon you already trust with that access.

Routes (Bearer token; a terminal that belongs to another session returns 404):

| Route | Purpose |
|---|---|
| `GET /v1/sessions/:sid/terminals` | `{ enabled, agentEnabled, terminals }`. Each terminal has `owner`, `controller` (`user` or `agent`), `shared`, and `command` for Luna's |
| `POST /v1/sessions/:sid/terminals` | Start one. Body `{ cols?, rows? }`. 403 when off, 503 when the machine is unavailable, 409 at the limit |
| `POST /v1/sessions/:sid/terminals/:id/ticket` | Single-use attach ticket, valid 30 seconds |
| `POST /v1/sessions/:sid/terminals/:id/control` | Body `{ action }`: `take`, `give`, `share`, or `unshare`. `give` and `share` need `terminal.agent`; `give` needs a shared terminal (409) |
| `DELETE /v1/sessions/:sid/terminals/:id` | Close a terminal |
| `GET /v1/terminals/:id/attach?ticket=` (WebSocket) | Raw input and output, plus `control` text frames. The Bearer token never goes in a URL |

## Luna's terminal tool

- `terminal.agent` (boolean, default `false`): give Luna the `terminal` tool. Settings > Tools > Terminal. Read live. While it is off the tool is not offered, `tool_search` does not find it, and calls are refused.
- The tool is a last resort for programs that need a real TTY: full-screen apps (vim, htop, less), REPLs driven over several turns, and prompts that refuse piped input. It is deferred, so Luna loads it with `tool_search`; plain commands stay with `bash` and `process`. `start` refuses a bare shell.
- Each terminal runs one program as `$SHELL -lc <command>` in the session's working directory and machine, and ends when the program exits. Workers need the `ptyCommand` capability; older workers say to update and restart.
- The daemon parses the output with the same ghostty VT engine as the browser (`ghostty-vt.wasm`, one instance per terminal) and gives Luna the screen as text: `start`, `send` (keys, text, Enter), `read` (with scrollback), `wait` (regex, exit, or idle; at most 60 s), `resize`, `list`, `stop`.
- `start` waits until the program draws its first screen (up to 8 s). `send` returns when the program has answered the input and gone quiet; with `pattern` it waits (up to `timeoutSec`) until a new match shows, so slow programs such as AI chat TUIs return their reply. A match is new when its line shows more often than before the input; scrolling an old match does not count.
- Keys accept names (Enter, Up, F5, PgDn), modifiers in common spellings (Ctrl-C, C-c, ^C, M-x, Shift-Tab, Shift-Up, Ctrl-Left), single characters (j, /), and repeats (Down*3). Multi-line `text` is sent as one bracketed paste when the program enabled it, else as Enter per line.
- Each screen ends with a `Highlighted:` line that names the spans drawn on a distinct background, such as the selected menu item, list row, or button; spans of only border or shading glyphs are skipped. Runs of four or more blank rows show as `[rows N-M blank]`.
- Luna's terminals appear in the dock, with only `terminal.agent` on too, and m57 watches them live. One side types at a time: **Take over** moves the keyboard to m57 and Luna's input is refused until he presses **Give to Luna**. While Luna types, m57's keys and sizes are dropped.
- m57 can **Share with Luna** one of his own shells. She can read it; she can type only after he gives it to her. **Stop sharing** hides it again.
- Terminals do not survive a daemon restart.

## Web frontend development

The web frontend uses Vue 3, Vite, TypeScript, Tailwind CSS, and shadcn-vue.
Run `bun run build:web` before starting the server. The server serves the build from `dist/web`, including the service worker.
The server does not need the frontend source files at runtime. Rebuilds update the served page and asset list without a server restart.
The build includes `.vite/manifest.json`. The service worker installs only the page, icons, manifest, and static entry dependencies.
After the page loads and the browser becomes idle, the worker caches remaining assets sequentially with low network priority.
This preserves full-build offline coverage after background caching completes. Before that, the installed shell and already cached views work offline.
Interrupted background caching resumes on the next online page load or reconnection. A worker update also starts background caching after page load.
API responses are never cached by the service worker. Offline navigation uses the installed page even with session-pane query parameters.
Offline session panes preserve same-origin framing; ordinary shell pages still deny framing through both frame headers.
Activation retains the current and one previous `luna-vue-` shell, so open pages can still use cached lazy chunks after an update.
Older Luna shell caches are removed. Other applications' caches are not changed.
During a rebuild, requests can fail while Vite replaces the output files. Reload after the build completes.
Run `bun run dev:web` for the Vite development server. It forwards API requests to Luna on port 8787.
Use `bun run typecheck:web` to check Vue components. `bun test` runs the backend and runtime unit test suite.

## Image and video analysis

`media_analyze(source, question, region?, use_active_model?)` analyzes one image or one video.
A source is a video when it is a `data:video/` URL or its path ends in `.mp4`, `.webm`, `.mov`, `.mpeg`, `.mpg`, `.avi`, or `.mkv`.
Video sources use the whole-video route below; `region` and `use_active_model` are rejected for them. All other sources use the image route.
The tool is offered when either the image route or the video route is available.

The image route accepts a local path, an HTTP(S) URL, or an image data URL.
Load the full image first. Then use `region` to inspect small text.
`region` is `{ "x": 0, "y": 0, "width": 200, "height": 100 }` in original-image pixels.
All values must be integers. Regions outside the image are rejected. Cropping occurs before resizing.
Local paths use the conversation working directory.

The tool is offered when native routing is available (including a profile-bypass retry), or an auxiliary vision route resolves with credentials.
In auxiliary mode, an image-capable active model alone does not make the tool available.
Native routing checks the model catalog. Unknown capability does not enable native routing.
Custom-provider discovery reads explicit `vision`, `supports_vision`, `capabilities.vision`, and image input modality lists
(`architecture.input_modalities`, `input_modalities`, or `capabilities.input`). Saved `vision` overrides take precedence.
Discovery does not infer image support from model names or image output modalities.

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

An explicit `auxiliary.vision` selection asserts that the selected model accepts images. Luna attempts that route even if
its catalog entry lacks image support metadata. This override applies only to the auxiliary request; it does not change
the shared catalog or enable native image results. The model must still exist in the catalog and have provider credentials.
If the model actually rejects images, its request error is returned instead of a local capability rejection.

Auxiliary routing uses `auxiliary.vision.model`, temperature `0.1`, and a 120-second timeout across attempts.
It sends the full-resolution image, or the full-resolution crop, with this prompt:
`Fully describe everything, then answer: <question>`.
A size rejection permits one smaller-image retry. An empty reply permits one further attempt.
The main model receives only `{ "success": true, "analysis": "..." }`, not auxiliary pixels.
Some visual detail can be lost in that text.

If no route resolves, the tool identifies a missing auxiliary setting, unknown provider, missing catalog model,
or unavailable credentials. It also states whether native routing is disabled by mode, blocked by a profile,
or unavailable because of catalog metadata or transport support. Provider-resolution failures use a controlled error message.
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


## User uploads

Incoming user files are separate from generated outputs. New uploads are saved as normal files under
`<dataDir>/uploads/<id>/<sanitized filename>`. The existing `dataDir` setting controls the root.
The original bytes are preserved, including original image resolution. File names retain their extension where possible.
Directories use mode `0700`, and files use mode `0600`. Uploads never go into a project directory.

The `luna_uploads` table in `luna.db` stores only an ID, name, MIME type, size, relative file path, and creation time.
New conversation entries, queued inputs, and submission records contain metadata and references, not original file bytes.
Image blocks use `luna-upload:<id>/<encoded filename>` internally. The model transport loads referenced pixels only for the request.
A bounded inference image is stored separately when needed; the downloadable original remains unchanged.
Non-image files, including documents, spreadsheets, archives, audio, and video, enter the prompt as untrusted file references for tools.
An uploaded file is never executed automatically. Provider and media-decoder limits still apply.

The web composer accepts any file type through the picker, paste, or drag and drop.
It shows upload progress, raster previews or file names, and authenticated download controls.
Normal chat and `/bg` accept at most 8 attachments, each up to 32 MiB. Empty generic files are allowed.
`/btw` and `/review` reject new attachments instead of silently ignoring them.

### Upload API

- `POST /v1/uploads?name=<filename>` accepts raw bytes and a `Content-Type` header.
  It returns `{ id, name, mimeType, size, path, ref }` with HTTP 201.
- Include `{ "type": "file", "uploadId": "<id>" }` in a message's `content` array to attach that file.
  Extra client paths and metadata are not trusted. Native PNG, JPEG, GIF, and WebP inputs receive image previews;
  other files remain available through tools.
- `GET /v1/uploads/:id` downloads the original bytes. It uses the normal bearer authentication,
  attachment disposition, `nosniff`, a sandbox CSP, and private/no-store caching. There is no public static upload directory.
- Legacy inline base64 image/audio message inputs remain accepted and are offloaded before durable submission.

Content/name/type-derived IDs make identical upload retries reuse the same file. Files are published before database references.
A missing or invalid stored file produces an error, not a silently incomplete prompt.
Worker sessions keep the original on main and copy the file into `<worker home>/.luna/uploads/` before submission.
The prompt names the execution-machine path. Workers must run the same Luna version and advertise upload support;
copy failure refuses submission, without falling back to a project path or main-host path.

Existing chat image payloads and board BLOB attachments remain readable. This change does not rewrite old history,
migrate old payloads, compact SQLite, or restart a running daemon. Back up both `luna.db` and the `uploads/` directory.
Uploads and shared files remain on disk after conversation/card deletion or attachment removal.
There is no automatic garbage collection, so forks, retries, and shared references cannot lose their files.

## Generated file storage

Persistent generated outputs that are not part of a project belong under `<dataDir>/generated/` on main.
The existing `dataDir` setting controls this root; there is no separate generated-output configuration field.
Luna creates these type directories at startup:

| Directory | Outputs |
| --- | --- |
| `images/` | PNG, JPEG, SVG, and other pictures |
| `documents/` | PDF, Word, plain text, Markdown, and other documents |
| `html/` | Standalone HTML pages and page bundles |
| `data/` | CSV, JSON, YAML, spreadsheets, and other data exports |
| `audio/` | Generated audio |
| `video/` | Generated video |
| `other/` | Archives and unclassified outputs |

An HTML page can keep its required assets together under `html/<unique-name>/`.
Use descriptive filenames with a unique suffix; do not overwrite unrelated results.
Generated HTML remains a downloadable file or an isolated chat preview. It is not served as an application-origin page.

Project source, tests, documentation, and required assets stay in the project.
An explicit user destination takes precedence. Temporary processing files keep their existing temporary/cache locations.
The session working directory and ordinary relative file-tool paths do not change.
Every runtime conversation, including children and scheduled runs, receives the machine-specific generated paths and these ownership rules.
General file tools and shell generators follow these instructions; this feature does not infer file purpose or sandbox arbitrary shell writes.
Built-in image generation and worker image delivery use the generated image directory directly.

Workers create the same type directories under `<worker home>/.luna/generated/` on their own machine.
Their generated files are not automatically synchronized to main. Update workers to the same Luna version as main.
A missing or incompatible worker has no fallback generated destination in a project directory or on main.
Storage errors do not authorize writing unrelated outputs into a project directory.
Directories are created with mode `0700`; built-in image files use exclusive writes with mode `0600`.
Existing directories are not chmodded. Files written through generic shell or file tools keep those tools' permission behavior.

Existing scattered files and legacy `<dataDir>/generated-images/` files are not moved or deleted.
There is no automatic cleanup or retention deletion. Deleting a conversation does not remove its generated outputs.
Answer-linked downloads continue to resolve files on the machine that produced the answer.

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
Local sources must resolve inside the conversation working directory (or configured `cwd`),
inside the generated `images/` directory, or inside upload storage on the session's execution machine.
The file descriptor is checked after opening, so symlinks cannot escape these allowed source directories.
Only generated image and upload directories are added, not the whole data directory with credentials and databases.
This is source-file confinement, not an operating-system sandbox.
HTTP(S) sources use the existing vision loader, with public-address checks, pinned DNS, redirect checks, and byte/pixel limits.
Data URLs are also accepted. Sources are decoded before provider dispatch; adapters receive pixels, not unchecked paths or URLs.
The Codex adapter normalizes edit sources to PNG and applies a 25 MiB per-image upload limit.

Each generation call makes one image submission. There is no automatic generation retry, provider fallback, or interrupted-call recovery replay.
Cancellation cannot restore quota already consumed by a submitted request.
Generated PNG files remain in `<dataDir>/generated/images/` with private file permissions. There is no automatic retention cleanup.
Legacy files under `<dataDir>/generated-images/` remain untouched.
Success results include `success`, `image`, `model`, `prompt`, `aspect_ratio`, `modality`, `provider`, and `upscaled`.
Errors include `success: false`, `error`, and `error_type`. Server error bodies and credentials are not exposed.
The tool returns a bounded image preview for chat delivery. If preview delivery fails, the successful file path is retained.
Use `media_analyze` on the returned local path to inspect the original.
Generated images in the session machine's generated `images/` directory can be edited directly without copying them into the project.

### Chat completions image models

Set `image_gen.provider` to `chat-completions` to use an image-output model from a provider you already configured,
such as Gemini Flash Image through an OpenAI-compatible proxy, OpenRouter, or ZenMux:

```json
{
  "image_gen": {
    "provider": "chat-completions",
    "chat-completions": { "provider": "cli-proxy-api", "model": "gemini-3.1-flash-image" }
  }
}
```

The provider must use the `openai-completions` API and the model must exist in its catalog.
Credentials come from the provider's stored login; the adapter has no keys of its own.
It posts one non-streaming request to `<baseUrl>/chat/completions` with `modalities: ["image", "text"]` and
`image_config.aspect_ratio`, and adds the ratio to the prompt because some endpoints ignore those fields.
Sources (up to 8) are sent as PNG `image_url` content parts. The first data-URL image in `message.images` or the
message content is saved as PNG, JPEG, or WebP. A text-only reply returns `no_image`, which usually means the model refused.
Output size is chosen by the model; the result records the requested ratio and the measured `pixel_size`.

Provider adapters implement `ImageGenProvider` in `src/image-gen.ts`.
The adapters are `src/plugins/image_gen/openai-codex.ts` (authentication in `src/codex-image-auth.ts`) and
`src/plugins/image_gen/chat-completions.ts`.
Register new adapters explicitly. Directory contents are not executed automatically.
Adapters must ignore unknown request fields. The dispatcher forwards only advertised controls.
Unsupported editing is checked before calling an adapter. JavaScript `TypeError` is `provider_exception`, not a Python keyword-argument error.
Unknown selected providers get one registry refresh attempt, then `provider_not_registered`.
Other providers, FAL, managed Nous/Krea/Portal gateways, and remote file synchronization remain unimplemented.
Unsupported gateway and nonlocal execution routes fail explicitly.

Offline checks: `bun test test/image-gen.test.ts`.
The opt-in live check is `bun run verify:image-gen:live --live`.
It uses an isolated runtime, submits exactly one real subscription generation, verifies chat preview delivery,
and retains the generated image under the configured data directory. It never changes live configuration.
The live check is excluded from the default suite and requires explicit permission to consume subscription quota.


## Whole-video analysis

`media_analyze` with a video source sends the complete video to an auxiliary provider and returns text only.
It never attaches the video to the main conversation. It does not extract frames, resize, crop, or apply image history/call limits.

The video route is available only when an authenticated auxiliary vision client resolves.
An explicit `auxiliary.vision` provider is authoritative. Without it, resolution tries the active provider, `openrouter`, then `nous`.
Automatic selection prefers a Gemini catalog model within each provider, then the active model, then other image-capable models.
An image-capable catalog entry is not proof of video support. Use a video-capable model such as Gemini.
Unsupported APIs/models return a structured error rather than sending the video to the main model.

```json
{
  "auxiliary": {
    "vision": { "provider": "openrouter", "model": "google/gemini-2.5-flash" },
    "video": { "provider": "openrouter", "model": "google/gemini-2.5-flash" }
  },
  "video": {
    "blocked_paths": [],
    "blocked_hosts": [],
    "timeout_ms": 180000
  }
}
```

An `auxiliary.video` entry with `provider` and `model` is authoritative. A model-only entry stays valid.
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

Run `bun test test/video.test.ts` for deterministic source, transport, auxiliary-request, and real-runtime tool tests.
These tests use controlled provider responses. They do not establish real-provider video understanding.
A live video-capable provider call requires explicit permission and is not part of the default test chain.

After approval, run a real clip with an expected answer pattern:

```sh
LUNA_VIDEO_LIVE_APPROVED=1 LUNA_CONFIG=/absolute/path/luna.config.json \
  bun run verify:video:live /absolute/path/clip.mp4 "Describe the motion and colors." "red|blue"
```

Review the returned description against the actual clip. A regex match alone does not prove complete video understanding.
The live script does not start or restart the daemon or edit configuration. Provider auth can refresh stored OAuth credentials.

## Project machines and creation

`POST /v1/projects` accepts `name`, optional host `cwd`, and optional
`worker` (registered numeric worker ID) with `workerCwd` (absolute path).

- Host-only: `{ "name": "Local", "cwd": "/home/user/project" }`.
- Worker-only: `{ "name": "Remote", "worker": 1, "workerCwd": "/home/user/project" }`.
- Both: supply the host `cwd` and the worker fields together.
- For compatibility, `{ "name": "Remote", "worker": 1, "cwd": "/home/user/project" }`
  treats `cwd` as the worker directory when `workerCwd` is omitted.

Creation returns `201` with `{ id, name, cwd, workerDirs }`. Worker-only projects
have `cwd: ""` and a `workerDirs` entry. Host paths must exist on the main host.
Worker paths must be absolute; the worker checks existence when used. Creating a
project records paths; it does not create filesystem directories. Offline workers
can be linked without executing anything on them.

Unknown workers return `404`. Invalid paths or incomplete worker fields return
`400`; duplicate names return `409`.

In Projects, **Create on** defaults to **Host**. Choose **Worker** for a worker-only
project or **Both** to require directories on both machines. Select a worker and
enter its directory for Worker or Both. Hidden directory fields are not submitted. Starting a chat selects the first linked worker
for a project without a host directory. The composer permits changing the machine.
Session creation, machine changes, and draft file completion reject a named project
on an unlinked machine with `400`, even when an explicit directory is supplied.
General chats retain the normal machine defaults. No operation falls back to main
when a selected worker is offline.

## Favourite projects

Every named project has a boolean `favorite` (default `false`). `GET /v1/projects` and
every project response include it. `PATCH /v1/projects/:id` accepts `{ "favorite": true }`
alone, without `name` or `cwd`, and returns the updated project. A non-boolean value
returns `400`. The flag is stored with the project, so it syncs across devices. The
web UI lists favourite projects first everywhere, keeps the existing order inside each
group, and marks them with a star in the sidebar. Existing databases gain the column
on startup. General cannot be a favourite (`409`).

## Project appearance

Named projects and the built-in General project (Chats, ID `0`) have nullable `color` and `icon` fields, stored in the project database.
`GET /v1/projects` and project responses include both fields. Existing projects default
to `null` (the theme's default folder or chat icon and color). Existing databases migrate on startup.
`PATCH /v1/projects/:id` accepts either field independently, without a name or directory:

```json
{ "color": "#818cf8", "icon": "code" }
```

`color` accepts a six-digit hex color (`#RRGGBB`, normalized to lowercase) or `null`.
`icon` accepts a supported built-in icon identifier (`folder`, `code`, `terminal`, `globe`, `smartphone`, `layers`, `database`, `book-open`, `briefcase`, `flask-conical`, `rocket`, `wrench`), a custom symbol or emoji consisting of exactly one visible non-whitespace grapheme (for example `π`, `A`, or complex emoji sequences such as `👩‍💻`), or `null`. Multi-grapheme strings, whitespace, control characters, and invisible or combining-mark-only characters are rejected.
Invalid values return `400`. For General (ID `0`), `color` and `icon` can be customized or reset, but changing `name`, `cwd`, `favorite`, or worker directories returns `409` (even when combined with appearance fields). Omitted fields are unchanged.
Use `{ "color": null, "icon": null }` to reset both. Appearance-only changes work even
when a project's directory no longer exists. Name, directory, machine links, and
favourite status are preserved.

In the sidebar, open a project (or Chats), then select **Manage → Appearance**. The Projects
panel also has an **Appearance** button for each project, including General. The dialog reads fresh
server state on each open, previews the icon and color, and applies them only on **Save**.
**Cancel** leaves saved settings unchanged. Favourite stars remain separate from the project icon.

## General chat board

The built-in **General** project is always available. It shares one persistent board across sessions in **Chats**.
Existing unlinked sessions use it automatically. Named project boards stay separate.
General does not change a conversation's working directory. It cannot be renamed, edited (except appearance), or deleted.
Scheduled runs and delegated children do not receive the board tool.

- `GET /v1/projects` includes `{ "id": 0, "name": "General", "cwd": "", "general": true }` before named projects (with custom or default `color` and `icon`).
  The empty directory means General has no directory override.
- `GET /v1/sessions` and `GET /v1/sessions/:id` report `project: 0` for General chats.
- `POST /v1/sessions` accepts `project: 0`. Omitting `project` also uses General.
  It accepts an optional `requestId` string (nonempty, at most 200 characters) for idempotent session creation. Repeated requests with the same `requestId` and matching creation parameters return the previously created session ID (`200 OK`). Conflicting parameters return `409 Conflict`. If the created session was subsequently deleted, retrying returns `410 Gone`.
- `GET /v1/session-creations/:requestId` performs read-only reconciliation lookup for a creation request ID. Returns `{ id }` (`200 OK`) if created and alive, `410 Gone` (`{ error: "session deleted", sessionId }`) if deleted, or `404 Not Found` if the request ID is unknown. It never creates new documents or sessions.
- `GET /v1/sessions/:id/submissions/by-request/:requestId` performs read-only lookup of an admitted submission within a session by its request ID, returning the submission record (`200 OK`) or `404 Not Found`.
- `GET /v1/session-defaults?project=&worker=&cwd=` resolves authoritative machine and directory defaults for fresh composer sessions, returning `{ worker, cwd }`.
- `POST /v1/sessions/:id/background-commands` and `GET /v1/sessions/:id/background-commands/:requestId` provide durable at-most-once submission and receipt lookup for slash commands executed in background sessions.
- Creation also accepts optional `model: { provider, modelId }` and `thinkingLevel` overrides. Valid reasoning levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Omitted overrides use the configured defaults. The empty chat keeps explicit choices locally and sends them when the first message creates the session.
- Existing board and card routes accept `/v1/projects/0/board` and `/v1/projects/0/cards`.
- `PATCH /v1/projects/0` allows `color` and `icon` appearance updates; other fields (`name`, `cwd`, `favorite`) and `DELETE /v1/projects/0` return `409`. The name General is reserved for new projects.
- Deleting a named project keeps its conversations and directories. Those conversations then use General.
- `GET /v1/projects/:id/skills` returns `[{ name, description, global, override, effective }]`. `global` is the global state (not in `disabledSkills`). `override` is `true`, `false`, or `null` (inherit). `effective` is `override ?? global`.
- `PUT /v1/projects/:id/skills/:name` with `{ "enabled": true | false | null }` sets the project override. `null` resets the skill to the global setting. It returns `404` for an unknown project or skill, and `409` for General (General uses the global setting only).
- `GET /v1/projects/:id/skill-mode` returns `{ onlyChosen }`. `PUT` with `{ "onlyChosen": true | false }` switches the mode (`409` for General). In "only chosen" mode the global setting does not apply: only skills with an `on` override are active, so skills added later stay off in that project. Turning the mode on saves the currently active skills as `on` overrides and drops `off` overrides, so the active set does not change at the switch. While the mode is on, `enabled: false` removes the override. Turning the mode off keeps the `on` overrides; every other skill follows the global setting again. In this mode `effective` is `override === true`.
- A skill disabled for a project is hidden from the skills list and cannot be loaded with `skill` `view` in that project's conversations. Overrides are deleted with the project.

### Background send (Ctrl+Enter / Cmd+Enter)

Pressing `Ctrl+Enter` or `Cmd+Enter` in the composer creates an independent, top-level empty session and sends the composer payload to it without navigating away or changing the visible view. The new session inherits the currently selected provider/model, thinking level, project, execution machine, and working directory (including active git worktree paths). It starts with a clean context: visible conversation history, instructions, and pending approvals are not copied.

The outgoing payload and snapshot are persisted to client-side IndexedDB before the composer clears, ensuring that draft text is not lost on network failure or unexpected refresh. Retrying after reload requires an explicit user action; unconfirmed sends are never automatically resubmitted. Any failed or uncertain background sends remain recoverable in the client outbox until confirmed or discarded. The new session shares the selected working directory on the target host (it does not create an isolated worktree). Client-only slash commands (`/model`, `/models`, `/compact`, `/compress`) are rejected in background send drafts and remain in the composer.

Open **Board** from the sidebar. It selects the active chat's project when opened.
General cards also appear in the composer's `#` picker. Card references remain scoped to the selected project.
The system prompt includes board card details only for explicit `#<id>` references in user messages still in context.
It does not include board counts or an automatic list of active or high-priority cards. Without a matching reference,
the board prompt section is omitted. The `board` tool remains available for explicit board queries and updates.

## Board events

A card whose owner is `session <id>` sends that session short events. Free-text owners such as `m57` get none.
An idle session starts a new turn. A busy session queues the event. A session that no longer exists loses the owner.

- A user change through `PATCH /v1/projects/:id/cards/:cardId` (status, archive, owner) sends one line to the owner.
  Changes made with the `board` tool send nothing to the changing session.
- `done` or archive sends a final event, then clears the owner.
- Blocked: the `board` tool sets `blocked` to a short reason, for example `needs your decision on X`. The board shows it. An empty string clears it.
- Answer: `PATCH` with `{ "answer": "text" }` sends the answer to the owner and clears the blocked reason.
- Move: `PATCH` with `{ "project": <id> }` moves the card to another project, General included. The card keeps its id,
  attachments, and activity. Dependencies outside the target project are dropped, the old project stops waiting on the
  card, and a `session <id>` owner is released. The editor offers the same move in its **Project** field.
- Dependency wake-up: when a card reaches `done`, the owner of each card that waits on it gets one line
  (`#40 is done, you can start #52`). If other blockers remain, the line names them.
- Activity: `GET /v1/projects/:id/cards/:cardId/activity` lists who changed the card and when, newest first
  (`user` or `session <id>`). The card editor shows it.

## Card attachments

A card can hold files under the daemon's upload directory. Limits: 10 MB per file, 20 files per card.
Cards in `GET /v1/projects/:id/board` list their `attachments` (`id`, `name`, `type`, `size`, `created`).
New attachment rows store an upload ID and an empty legacy BLOB; original bytes live only on disk.
Legacy BLOB rows remain readable without destructive migration.
The `board` tool shows attachment names in `get`. Deleting a card/project or removing an attachment deletes its association,
not shared upload files on disk.

- `POST /v1/projects/:id/cards/:cardId/attachments?name=<file>`: the request body is the raw file. `Content-Type` is kept.
- `GET /v1/projects/:id/cards/:cardId/attachments/:attachmentId`: downloads the file as an attachment.
- `DELETE /v1/projects/:id/cards/:cardId/attachments/:attachmentId`: removes it.

Each saved board card has a paperclip button to open its editor and select files.
The button shows the attachment count when files are present.
The card editor has an **Attachments** list with attach, download, and remove.
Supported image formats show a preview in this list. New cards must be saved before attaching files.

## Execution machines (first version)

One main daemon owns sessions, history, agent execution, models, skills, memory, settings, and schedules.
A worker runs file, shell, browser, and MCP operations for sessions that explicitly target it.
Opening or sending instructions to a session never changes its execution machine.
Web, image generation, vision, and video tools run on main. In a worker session, they read local file paths from the worker.
`media_analyze` applies the video credential checks and `video.blocked_paths` on the worker. Paths resolve against the worker's directory.
`image_generate` source images must be inside the worker's working directory, generated `images/`, or upload storage.
The worker opens each protected file once. It checks the opened file and reads from it, so a symlink swap cannot redirect the read.
These protected reads need a Linux worker at the same Luna version as main. Other workers refuse them.
A generated image is copied into `<worker home>/.luna/generated/images/` with a unique filename and private permissions.
The worker selects the destination; the daemon cannot supply a destination for this delivery operation.
Known missing generated-storage support is refused before an image submission.
If delivery fails after generation, the tool reports `worker_delivery_failed` and gives the path of the original on main. Do not regenerate the image.

### Register and connect

In **Settings → Tools & connections → Execution machines**, create a named machine.
Copy its token immediately. Luna shows it once and stores only its hash in `<dataDir>/workers.db`.
The token grants execution-worker access, not access to the shared HTTP API.
Removing a machine revokes its token and closes its connection.

Use the same package checkout and `bun install --frozen-lockfile` on the worker machine.
The worker runs on Bun: install Bun 1.4.4 or newer and start it with `bun run worker`. Node-only workers stop working after they update to this version. It does not need provider keys or a session database.
Set these environment variables through your shell or service configuration:

```sh
export LUNA_URL=https://your-main-luna
export LUNA_WORKER_TOKEN=lw_your_worker_token
export LUNA_WORKER_CWD=/home/you/Projects  # optional; default: home directory
bun run worker
```

Workers dial main over WebSocket on the main HTTP port. They need no inbound port.
Use HTTPS/WSS or a trusted private network. Do not send bearer tokens over an untrusted plain HTTP network.
Reverse proxies must forward the WebSocket upgrade at `/v1/workers/connect`.
Worker tokens permit arbitrary commands on the worker through sessions assigned to that machine.
Run workers as the desktop user, not as root.
The worker and the main daemon remove `LUNA_WORKER_TOKEN` and `LUNA_TOKEN` from their own environment at startup, so commands cannot read them.
A frame over 128 MiB fails only its call; the link stays up. File and reader calls fail after 120 seconds without an answer (the command or file state is then unknown). Exec, browser and MCP calls keep their own limits.

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
bun run connect
# Equivalent: bun run chat connect
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
The old `bun run chat --session ID message` interface remains available.

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
It also includes `parentSessionId`: the existing parent of a delegated child or the verified lead of a crew member, otherwise `null`. Ordinary fork ancestry does not count as delegation. The web chat header shows **Back to main agent** when this field is set; it opens that parent session through the normal navigation, including split tiles.
Forks, delegated children, and background-task sessions keep their parent's execution machine.
Native background processes use that environment and retain their output centrally.
Files named by an assistant `MEDIA:` directive are fetched on demand from the source worker.
For sessions created through the API, existing answer attachments keep their source after execution transfers.

### Session model identity and changes

Each session's `active-model` system prompt section identifies its resolved provider and model ID.
Changing the model through `PATCH /v1/sessions/:id` records a durable `luna.model-changed` entry.
Its data includes `previous`, `model`, and `text`; the event also enters model context and appears in chat history.
Selecting the same model or changing only thinking level or instructions does not create a model-change event.
Clearing the model records that no model is selected. Model changes do not start an assistant turn.

The reasoning control can change `thinkingLevel` while the session is busy.
A thinking-only `PATCH /v1/sessions/:id` saves the level immediately, including `null` to reset it to `off`.
The change applies to the next model request, including the next tool round in the current run.
It does not restart or interrupt an in-flight model request or tool.
Patches that include `model` or `instructions` still return 409 while busy, even when they also include `thinkingLevel`.

### OpenAI speed (Fast and Ultrafast)

OpenAI and OpenAI Codex models that use the Responses API accept a speed: `fast` (sent as `service_tier: "priority"`,
about 2x the standard price) or `ultrafast` (about 6x; only `gpt-6-astra` and `gpt-6.1-sol`). `GET /v1/models` lists each
model's `speeds`; an empty list hides the lightning button next to the reasoning control.
`PATCH /v1/sessions/:id` with `speed: "fast" | "ultrafast" | null` saves it, also while busy, and `POST /v1/sessions`
accepts the same field. The session view returns `agent.speed`. Speed applies from the next model request.
On a model without Ultrafast, `ultrafast` runs Fast; on a model without service tiers, requests run at standard speed.
Usage cost includes the tier multiplier.

### Lightweight session history

`GET /v1/sessions/:id?view=ui&limit=100` requests a display-only projection.
System messages omit their sections (`sections: {}`, `sectionsOmitted: true`) and their
tool-definition changes (`toolsAdded`/`toolsRemoved` removed, `toolsOmitted: true`).
Assistant content blocks omit provider replay signatures (`textSignature`, `thinkingSignature`).
Tool-result text blocks larger than 8 KiB include only a 2 KiB head and tail,
with `truncated: { originalBytes }`. UTF-8 boundaries remain intact.
Stored entries, provider context, and the default API response are unchanged.
The UI projection returns `contextUsage: null` to avoid scanning the active context
before showing messages. Add `context=1` to include the complete estimate. After attaching
the event stream, the UI fetches `?view=ui&limit=1&context=1` once to refresh both the
estimate and custom documents. `GET /v1/sessions/:id/context` remains available for later
context-only updates.

The response includes `hasMore` and `nextCursor`. Pass that cursor as `before`
to fetch older entries in descending order. The web UI loads 100 entries first
and provides a **Load older messages** button. Reconnecting retains loaded history.

### Paginated session list

`GET /v1/sessions` without query parameters preserves the legacy response: `{ "sessions": [...] }` with all visible sessions, full metadata, and default ordering (pinned descending, activity descending, id descending).

Supplying query parameters opts into the paginated metadata protocol:
`GET /v1/sessions?limit=50`

Query parameters:
- `limit`: Integer from 1 to 100 (default 50).
- `archived`: `0` (active only, default), `1` (archived only), or `all`.
- `project`: `none` (General/unassigned/unknown), or a positive integer project id. Omitted matches all projects.
- `worker`: `main` (main host only), or a positive integer worker id. Omitted matches all execution machines.
- `q`: Search terms. Matches case-insensitive whitespace-split tokens (AND logic) across session title, session id, and project name.
- `cursor`: Opaque base64url keyset cursor encoding `[pinned, activity, id]`. Malformed cursor returns HTTP 400. Fresh cursors must be used when filters change.
- `ids`: Comma-separated positive integer conversation IDs (up to 100).
- `running`: `1` to filter running or reviewing sessions. When `ids` and `running=1` are both supplied, sessions matching either condition are included (used for background notification tracking).

The paginated response returns:
```json
{
  "sessions": [...],
  "nextCursor": "<opaque-cursor-or-null>",
  "total": 12,
  "groups": {
    "none": {
      "count": 5,
      "lastActivity": 1710000000000,
      "activity": 1710000000000,
      "statuses": { "ready": 4, "running": 1 },
      "machines": { "main": 5 }
    },
    "1": {
      "count": 7,
      "lastActivity": 1710000050000,
      "activity": 1710000090000,
      "statuses": { "ready": 7 },
      "machines": { "main": 5, "2": 2 }
    }
  }
}
```

The web sidebar loads 50 matching rows first and loads later pages only on request. Search, archive, project, and machine filters run on the server.
Refreshing retains the loaded window. Bulk selection applies to loaded conversations; the control states this when more pages remain.
Command-palette and mention searches query the server independently, with loading and retry states. Project counts use global summaries, not the loaded page.
Global completion notifications track active and previously active sessions independently of the sidebar page.
The protocol bounds HTTP metadata pages and client allocations. It still scans cached session rows to compute exact global summaries; it does not bound cold backend scans.

`groups` is computed over all visible sessions (excluding delegate subagents) without applying `project`, `worker`, or `q` filters. `activity` reflects the maximum activity timestamp across both archived and unarchived sessions for stable project ordering; `lastActivity`, `count`, `statuses`, and `machines` reflect the selected `archived` mode.

`GET /v1/sessions/:id/events?view=ui&after=<entryId>` uses the same projection.
The atomic SSE snapshot contains only entries newer than the hydrated page's newest
entry. This closes the fetch/subscribe gap without resending the entire transcript.
Default SSE clients continue to receive the full snapshot.

`GET /v1/sessions/:id/entries/:entryId/tool-result?toolCallId=<id>` retrieves
full tool text when the user selects **Show full output**. It requires the normal
bearer token and checks entry visibility through the session's fork lineage.
The `entryId` identifies the result entry, not the assistant tool-call entry.

### Session image transport

Session detail responses and both SSE streams replace embedded PNG, JPEG, GIF, and WebP
base64 image blocks in committed entries with `{ type: "image", mimeType, data: "", url }`.
Stored entries and model history stay unchanged. Upload references still use `/v1/uploads/:id`.

`GET /v1/sessions/:id/entries/:entryId/images/:index` returns the original image bytes.
The zero-based index follows array order and object-key order through the entry.
The route requires normal bearer authentication and checks entry visibility through the session's
fork lineage. Parent entries after the fork point and unrelated entries return 404.
Historical images remain available after reset or undo, like historical transcript entries.
Responses use a raster MIME allowlist, `Cache-Control: private, no-store`, and `X-Content-Type-Options: nosniff`.
The web UI uses authenticated blob requests; tokens are not included in image URLs.

Live partials and nested tool results without committed entry IDs remain inline.
This transport needs no configuration changes; `luna.config.example.json` stays unchanged.

### Cross-machine command execution (`worker_exec`)

`worker_exec` was named `machine_exec`. `subagent` was `delegate_task`, and `session_status` was `session_handoff`. Saved configs that list an old name (`codemode.pinned`, `disabledTools`, subagent profile `tools`) get the new name on load.

`worker_exec` runs a bash command on any machine, from every session, whatever its own machine:
main to a worker, a worker session to main, and a worker session to another worker.
Parameters: `machine` (`main` or a worker name, case-insensitive), `command`,
optional `cwd` (absolute or `~/...` on the target machine) and `timeout` (seconds).
Without `cwd`, the command runs in the session cwd when the target is the session's own machine, else in the target machine's home.
Output streams and is truncated like `bash` (last 2000 lines or 50KB). A nonzero exit is an error result with the exit code.
Spilled full output stays on the target machine; the diagnostic names it as `<machine>:<path>`, readable with `worker_exec` (`cat`).
Abort and `timeout` stop the command on the target machine. An unknown machine returns the valid names; an offline worker returns an error without running anything.
Worker targets use the existing worker exec call; the worker protocol is unchanged. There is no per-worker permission gate.
The machine section of the system prompt mentions the tool only when at least one worker is registered.
No configuration is needed; `luna.config.example.json` stays unchanged.

### Browser and MCP on a worker

In a worker session, `browser_*` tools drive the worker's browser. Main MCP servers stay available.
The worker reads `browser` and `mcpServers` from `~/.luna/luna.config.json` on its own machine, unless `LUNA_CONFIG` selects another file (for example, `~/.luna/worker.config.json`). Its launch directory does not affect the default config path.
A worker without `browser.provider` set reports that browser tools are not enabled. It never fakes a page.
Workers report their browser provider, configuration status, and configuration error in their connection capabilities.
The agent sees this status in its machine instructions. Calls to a worker with an unconfigured browser fail before dispatch.
Configuration status checks executable access or the Camofox MCP configuration; it does not prove a successful browser launch or MCP connection.
Older workers without this capability report availability as unknown and retain call-time checks.
There is no automatic fallback to the host browser. Restart the worker after changing browser configuration.

For Helium on a NixOS desktop, merge this into the worker's own configuration:

```json
{
  "browser": {
    "provider": "chromium",
    "providers": {
      "chromium": {
        "executablePath": "/run/current-system/sw/bin/helium",
        "headless": true
      }
    }
  }
}
```
Each MCP server on the worker appears as deferred tools named `w<workerId>_<server>__<tool>`.
Only sessions on that worker can find or call them. Main sessions and sessions on other workers cannot.
The worker starts its MCP servers when it connects. Restart the worker to apply config changes.
Screenshots return through the worker link on demand.

### Disconnection and recovery


History and last known progress stay on main when a worker disconnects.
In-flight calls fail. New file, shell, browser, and worker MCP calls fail with "Nothing ran" instead of falling back to main.
Calls are never automatically replayed after reconnect. A new link cannot reuse an old file-reader handle.
Worker shutdown and a detected connection loss abort its commands and close readers.
A hard crash can leave OS processes running. Main reports their state as unknown; check before repeating a command.
The worker reconnects automatically with bounded delay. Removing its token stops future connections.
New agent turns require main to be reachable. There is no independent desktop agent loop or offline session store.

Verification:

```sh
bun test test/worker-exec.test.ts test/workers-cli.test.ts
# Opt-in real desktop test. Copies a temporary bundled worker; installs no desktop service.
LUNA_TEST_DESKTOP=m57@192.168.1.11 LUNA_TEST_MAIN_URL=http://192.168.1.57 bun run verify:workers:desktop
```

## Manual session pruning

In **History → History actions → Prune sessions**, enter a positive whole number of days (default seven).
The preview counts sessions across all projects. When a project folder is open, **Only in project** (on by default) limits it to that project. Archived sessions are excluded unless **Include archived sessions** is selected.
The dialog lists each session that will be deleted, with its age and the number of forks and subagents deleted with it. Clear a session to keep it.
The preview waits for a pause in typing before it runs.
The selected session and open split tiles are protected, together with their forks and subagents. Running tasks, background processes, and side questions are also protected.
Pinned sessions are always protected, including archived pinned sessions. There is no automatic schedule or configuration setting.

Age uses the newest user or assistant message timestamp, including cross-session messages.
Creation time protects newer sessions and forks with inherited old messages. Empty sessions use their creation time.
Sessions with no known message or creation timestamp are kept. A day means 24 hours; the cutoff is strictly older than the selected age.
Renaming, pinning, archiving, and reading do not count as message activity.

Both endpoints require the normal API authorization:

- `POST /v1/sessions/prune/preview` accepts `{ "days": 7, "includeArchived": false, "excludeIds": [123], "projectId": 5 }`.
  `projectId` is optional; when set, only sessions linked to that project are considered.
  It returns `{ "ids": [456, 789], "sessions": [{ "id": 456, "title": "Fix login", "activity": 1793778132801, "ids": [456, 789] }] }` without deleting sessions.
  `ids` lists every session to delete. `sessions` has one item per top-level session, oldest first; its `ids` is that session followed by the forks and subagents deleted with it.
  `excludeIds` contains the sessions the client must keep. Their forks and subagents are kept too.
- `POST /v1/sessions/prune` accepts the same fields plus `"ids": [456, 789]` from the preview.
  It rechecks age, pin state, archive state, exclusions, running work, and descendants on the harness mutation line.
  It returns `{ "deleted": [456, 789] }`, which can be smaller than the preview. It never adds unconfirmed sessions.

All fields are required. Unknown fields, invalid IDs, and nonpositive or fractional days return `400`.
An empty confirmation list deletes nothing. To keep one listed session, leave its `ids` out of the confirmation list. Disabled conversation management returns `404`.
A fork or delegated child must also qualify before its parent can be removed.
Pinned, recent, archived, running, excluded, or unconfirmed descendants protect their ancestors from cascading deletion.
Deletion uses the existing atomic hard purge, including messages, descendants, documents, metadata, and search entries.
It is permanent. A failed purge leaves the selected sessions intact; the UI reports the error. A storage fault can require a daemon restart before retry.

### Analytics snapshots

`GET /v1/analytics` returns a complete analytics snapshot. The daemon shares concurrent
requests and reuses successful snapshots for up to three seconds. `generatedAt` reports
when the snapshot was built; session statuses reflect that time. Use
`GET /v1/analytics?refresh=true` to bypass snapshot reuse (an active refresh is shared).
The Analytics Refresh button uses this option. Failed refreshes can be retried.
A delayed scan warms the cache 30 seconds after startup. Scans release the harness
queue between conversations and yield during entry paging. Analytics is eventually
consistent across conversations, not one atomic point-in-time database snapshot.

The web UI retains the last snapshot while the analytics window is closed and refreshes
it on reopen. Changing the server or authentication token clears this client snapshot.

#### Overview and session explorer

`GET /v1/analytics?view=overview` returns the same totals and charts, but includes only
five recent rows in `sessionsList`. The `sessions` count and `statusBreakdown` still
cover all retained conversations. The web overview uses this smaller response.
The default endpoint remains compatible and returns all session rows.

`GET /v1/analytics/sessions` filters, sorts, and paginates session rows on the daemon.
It accepts these optional query parameters:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `search` | empty | Case-insensitive title substring or session ID substring. |
| `status` | empty | Exact session status; empty includes every status. |
| `sort` | `tokensDesc` | Column name (`title`, `status`, `tokens`, `cost`, `hitRate`, `responses`, `duration`, or `activity`) followed by `Asc` or `Desc`. Sorting applies before pagination; unreported values stay last in both directions. |
| `page` | `0` | Nonnegative integer page index. Out-of-range pages clamp to the last page. |
| `limit` | `20` | Integer page size, from 1 to 100. |
| `refresh` | `false` | `true` bypasses snapshot reuse; concurrent refreshes share one computation. |

The response contains `generatedAt`, `sessions` (the current page), `total` (matching
sessions), `allTotal`, `statusBreakdown`, `page`, and `limit`. Filtering and sorting
happen before pagination. Invalid pagination or sort parameters return HTTP 400.
The explorer fetches rows only while open; it refreshes on reopen. Changing filters
resets pagination, and stale responses cannot replace newer results.

Both analytics routes send `Cache-Control: no-store`. The daemon's short snapshot
cache is separate from HTTP caching. `Server-Timing` reports analytics request time;
the overview route also reports JSON serialization time. These timings are visible
in browser network tools. Browser Performance measures record overview request and
render work without adding dashboard controls.

Snapshots include `performance`: `scanMs`, `aggregationMs`, `metadataMs`,
`entriesScanned`, `conversationsScanned`, and `cacheHits`. These describe the snapshot
build, not later cache hits. `aggregationMs` includes session status reads and other
work outside the history scans and bulk metadata queries. Browser Performance entries
use `analytics-request`, `analytics-render`, and `analytics-request-to-render`; the last
sample for each name replaces the previous sample. Render timing ends after Vue's DOM
update, not the browser's paint.

Conversation summaries reuse immutable retained entries and scan only entries after
the last processed ID. Usage ledgers are refreshed independently and remain the source
of token and cost totals, including compaction. Structural history changes rebuild the
affected summary. Deleted conversations are pruned from the cache at the next build.
The first request after daemon startup still needs a full retained-history scan.

### Workspace Git status

`GET /v1/sessions/:id/git` reads the session execution machine and working directory. It returns `state` (`ok`, `not-repository`, `unavailable`, or `error`). Successful reads include `branch`, `upstream`, `ahead`, `behind`, `added`, `deleted`, `untracked`, `conflicts`, and `files` (path, two-character status, added/deleted counts, binary flag). Totals compare tracked staged and unstaged changes with HEAD; untracked contents are excluded. Ahead/behind uses local upstream information without fetching. Reads share a four-second workspace cache. The UI shares one poller across both Git status displays and refreshes every five seconds while visible and on focus. This endpoint never changes Git state.

## GitHub workspace

Open **Source Control** from the sidebar, command palette, or `#source-control`. Old `#github`
links still work. The page uses the main host's GitHub login. The daemon calls `api.github.com`
directly over reusable HTTP connections; it does not start `gh` for each API request.
`GH_TOKEN` takes precedence over `GITHUB_TOKEN`. Without either variable, run `gh auth login`
under the daemon account first. The daemon reads the token once with `gh auth token --hostname github.com`
and keeps it in memory. It must receive the correct `HOME`, `GH_CONFIG_DIR`, or `XDG_CONFIG_HOME`.
Tokens never reach the browser. Only github.com is supported. Workers do not run GitHub requests.
A credential rejection clears the saved token. Read requests may reload it and retry once;
write requests are never retried automatically. Restart the daemon after switching the stored GitHub account.

The repository selector reads each project's `origin` remote and also accepts `owner/repo`.
Project discovery runs at most four Git commands at a time and caches the mapping for 30 seconds.
Lists refresh on page open, tab changes, manual refresh, and actions; there is no background polling.
Empty searches use repository connections; text searches use GitHub search. Both return 30 items per page.
PR and issue bodies use the safe Markdown renderer, not executable assistant artifacts.

GitHub reads use a bounded, per-daemon memory cache: status 5 minutes, repository metadata 10 minutes,
list pages 30 seconds, and item detail 15 seconds. Identical pending reads share one request.
Failed reads are not cached. GitHub writes clear the affected repository's cached reads, even on failure.
Write permission, mergeability, branch, and SHA checks always read fresh GitHub data.
Add `fresh=1` to status, repository metadata, list, or detail GET requests to bypass the cache.
The UI Refresh button uses this flag. These policies need no configuration fields.

The browser keeps up to 100 read entries in memory. A loaded list or item appears immediately on return,
while a background request updates it. The displayed update time refers to the last successful list fetch.
Changing the daemon address or Luna login token clears this browser cache. Actions invalidate the affected
repository. The other list tab is prefetched for empty searches; desktop hover and keyboard focus can
prefetch item detail after 150 milliseconds. Prefetch failures do not replace the selected item.

All routes below use normal Luna API authentication. `:owner` and `:name` are repository parts;
`:number` is a positive item number. JSON bodies reject unknown properties.

| Method | Route | Body or query |
|---|---|---|
| GET | `/v1/github/status` | CLI/login status, authenticated GitHub login |
| GET | `/v1/github/repos` | Repositories grouped with matching project ids and names |
| GET | `/v1/github/repos/:owner/:name` | Repository permissions and allowed merge methods |
| GET | `/v1/github/repos/:owner/:name/items` | `kind=pr\|issue`, `state=open\|closed\|all`, optional `q` (256 characters), `after` cursor, filters `author` (`@me` or a login), `label`, and for PRs `draft=true\|false`, `review=approved\|changes_requested\|required`; 30 items/page. Filters become search qualifiers, so a filtered list uses GitHub search |
| GET | `/v1/github/repos/:owner/:name/items/:number` | Description, latest 30 comments, `commentTotal`, `commentsBefore` cursor (or null), PR checks and recent reviews, action capabilities |
| GET | `/v1/github/repos/:owner/:name/pulls/:number/files` | `page=1`–`30`; 100 changed files per page with status, +/- counts, and `patch` (null when GitHub omits it for binary or very large files); `more` flag |
| GET | `/v1/github/repos/:owner/:name/items/:number/comments` | Required `before` cursor (max 1000 characters); returns earlier 30 comments and `before` cursor (or null) |
| POST | `/v1/github/repos/:owner/:name/items/:number/comments` | `{ "body": "comment" }`, 1–65536 characters |
| POST | `/v1/github/repos/:owner/:name/items/:number/state` | `{ "kind": "issue", "state": "closed", "reason": "completed" }`; reason optional, `completed` or `not_planned`; state `open` or `closed` |
| POST | `/v1/github/repos/:owner/:name/pulls/:number/merge` | `{ "method": "squash", "sha": "<40-character head SHA>" }`; method `merge`, `squash`, or `rebase` |
| POST | `/v1/github/repos/:owner/:name/pulls/:number/delete-branch` | `{ "sha": "<40-character head SHA>" }` |
| GET | `/v1/github/repos/:owner/:name/labels` | Up to 100 repository labels (name, color) |
| GET | `/v1/github/repos/:owner/:name/assignees` | Up to 100 users who can be assigned |
| POST | `/v1/github/repos/:owner/:name/issues` | `{ "title", "body"?, "labels"?, "assignees"? }`; returns `{ number, url }` |
| POST | `/v1/github/repos/:owner/:name/pulls` | `{ "title", "head", "base", "body"?, "draft"? }`; returns `{ number, url }` |
| PATCH | `/v1/github/repos/:owner/:name/items/:number` | `{ "kind", "title"?, "body"?, "labels"?, "assignees"? }`; only the given fields change; returns the fresh detail |
| POST | `/v1/github/repos/:owner/:name/pulls/:number/review` | `{ "event": "APPROVE\|REQUEST_CHANGES\|COMMENT", "body"?, "sha" }`; the body is required unless approving; a changed head returns 409 |
| POST | `/v1/github/repos/:owner/:name/pulls/:number/draft` | `{ "draft": true }`; converts to draft or marks ready |
| POST | `/v1/github/repos/:owner/:name/pulls/:number/update-branch` | `{ "sha" }`; asks GitHub to merge the base branch into the head; a changed head returns 409 |
| DELETE | `/v1/github/repos/:owner/:name/issues/:number` | `{ "confirm": 12 }`; must equal the issue number; permanent, requires GitHub deletion permission |
| GET | `/v1/github/repos/:owner/:name/items/:number/cards` | Required `kind=pr\|issue`; matching projects and linked active/archived board cards; no GitHub detail request |
| POST | `/v1/github/repos/:owner/:name/items/:number/card` | `{ "project": 1 }`; creates a todo/medium card (201), or returns an existing linked card (200) |

Use **Load earlier comments** in item detail to prepend older comments without reloading the item.

The server checks action permissions again before submitting a write. GitHub also enforces repository
rules. Merge submits the displayed SHA; a changed head is rejected. Branch deletion checks the current
ref SHA first, but GitHub's ref-deletion API has no atomic SHA precondition: another push between that
check and deletion remains possible. Default branches and branches without write permission cannot be deleted.
A concurrent action on the same item returns 409; writes are not automatically retried.
GitHub credential failures return 502, not Luna's login-triggering 401. Other errors include 400 (invalid
input), 403 (permission), 404 (missing item), 409 (conflict), 422 (rejected action), 503 (missing CLI),
and 504 (timeout).

**Add to board** uses the project whose origin matches the repository. If several projects match, choose
one. If none match, the button is disabled. The card starts with the canonical GitHub URL on its own
line, followed by author/date and body (truncated at the board's 8000-character description limit).
That URL links the item to the card: removing it removes the link. Existing archived cards are also
reused. Opening a link selects the correct project and opens that card's editor. There is no automatic
state synchronization between GitHub and board cards.

## Source Control: local Git

The former **GitHub** page is now **Source Control** (`#source-control`). Old `#github` links redirect.
The page has **Changes**, **History**, **Branches**, **Pull requests**, and **Issues** tabs.

- **History** shows a commit graph for the current branch or all branches (local, remote, and tags),
  100 commits per page. Select a commit to see its message, parents, refs, and changed files. Merge
  commits show their changes against the first parent.
- **Branches** lists local branches with upstream ahead/behind counts and the last commit; branches
  without a commit for 90 days are marked stale. **Compare** shows the commits and file changes of one
  revision since it split from another (three-dot, the same as a pull request).
- A pull request has a **Files changed** view next to its conversation. GitHub omits the diff of binary
  and very large files; those link to GitHub.
- All diffs show old and new line numbers. Wide views can switch between unified and split layouts;
  the choice is saved in the browser.

History, commit, compare, and range-diff requests are read-only, never cached, and run with
`--no-optional-locks`. Revisions are resolved with `rev-parse --verify --end-of-options`; values that
start with `-` are rejected.

Changes uses the active session's machine and working directory. Without a session, choose a project
with a main-host directory. Git commands run on that machine, not in the browser. The displayed cwd is
the repository root. The GitHub tabs follow the workspace's github.com `origin` remote when available.

Every `/v1/git/*` request requires exactly one query selector: `session=<id>` or `project=<id>`.
It uses the normal Luna API authentication. Offline workers return 503. Project selection runs on the
main host; General and projects without a host directory are rejected.
Add `machine=<worker id>` or `machine=main` to a `project` selector to run on that execution machine's
directory for the project. The context bar at the top of the page sets project, machine, and repository.

The page remembers its tab, state filter, and layout choices in the browser. Deep links such as
`#source-control/pr/12` open an item. Keys: `r` refresh, `/` search, `Esc` back, `j`/`k` move in a list.
**Start session** on a PR or issue opens a new chat with the item in the composer; it never sends.

| Method | Route | Body / extra query |
|---|---|---|
| GET | `/v1/git/changes` | Branch, upstream, ahead/behind, detached/unborn state, files, cwd, machine, GitHub repo |
| GET | `/v1/git/branches` | Current branch, local names/upstreams/counts/last commit date and subject, origin remote branch names, `default` branch name (or null) |
| GET | `/v1/git/diff` | `path=<relative path>&staged=0` or `staged=1`; plain diff text, binary/truncated flags |
| GET | `/v1/git/log` | `scope=head\|all`, `skip` (0–1000000), `limit` (1–500, default 100); `{ commits, more }` in topological order; each commit has oid, parents, author, email, date, typed refs (`head:`, `local:`, `remote:`, `tag:`), subject |
| GET | `/v1/git/commit` | `oid=<4–64 hex>`; full message, author, committer, parents, refs, `base` (first parent or the empty tree), changed files with status and +/- counts (up to 3000) |
| GET | `/v1/git/compare` | `base=<rev>&head=<rev>`; three-dot comparison: resolved oids, `mergeBase`, ahead/behind, up to 250 commits, changed files since the merge base |
| GET | `/v1/git/range-diff` | `base=<oid>&head=<oid>&path=<path>`, optional `original=<old path>` for renames; one file's diff between two commits (512 KB limit) |
| POST | `/v1/git/stage`, `/v1/git/unstage` | `{ "paths": [...] }` or `{ "all": true }` |
| POST | `/v1/git/discard` | `{ "paths": [...] }`; permanent. Staged and conflicted files are refused (409) |
| POST | `/v1/git/stash` | `{ "message"?, "includeUntracked"? }` |
| POST | `/v1/git/stash-pop`, `/v1/git/stash-drop` | `{ "index": 0 }`; a stash that changed since listing returns 409 |
| GET | `/v1/git/stashes` | `{ stashes: [{ index, date, subject }] }` |
| POST | `/v1/git/delete-branch` | `{ "branch", "force"? }`; the current and default branch are refused; an unmerged branch returns 409 `confirm-force:` until `force` is true |
| POST | `/v1/git/update-from-default` | `{}`; needs a clean tree; merges `origin/<default>` and aborts the merge on conflict (409) |
| POST | `/v1/git/checkout-pr` | `{ "number" }`; needs a clean tree; fetches `pull/<n>/head`, creates or fast-forwards local `pr-<n>`; a diverged local branch is left alone (409) |
| GET, POST | `/v1/git/commit-message` | GET: `{ available }`. POST: drafts a message from the staged diff with the title model; only on request, never automatic |
| POST | `/v1/git/commit` | `{ "message": "Commit message", "amend"?, "force"? }`; amending a commit that origin already has returns 409 `confirm-amend:` until `force` is true |
| POST | `/v1/git/switch` | `{ "branch": "feature" }`, or `{ "branch": "feature", "create": true, "from": "HEAD" }`; remote branch: `origin/feature` |
| POST | `/v1/git/fetch` | `{}`; fetches and prunes origin |
| POST | `/v1/git/pull` | `{}`; requires an upstream and uses `--ff-only` |
| POST | `/v1/git/push` | `{ "expectedBranch": "feature", "expectedHead": "<40-character SHA>", "setUpstream": true }` to publish; optional `confirmDefault: true` only after explicit default-branch confirmation |

Repository-root lookup is cached per machine and working directory for 60 seconds (at most 200 entries).
Status and origin lookup run together. Diff requests check only the selected path's current status;
they retain repository membership and parent-path safety checks. Writes still scan fresh Git status
before and after the action. No Git change or diff results are cached.

Mutation results contain `{ changes, summary, sha }`. Paths must be current changes in the repository,
relative and literal; absolute paths, traversal, and escaping parent symlinks are rejected. Up to 500
paths are accepted. Commit messages must contain 1–10000 characters. Unknown body fields are rejected.

With more than 5000 untracked files (for example an unignored build folder), untracked folders are
listed as single entries ending in `/` and `untrackedCollapsed` is `true`; staging such an entry adds
the whole folder. `/v1/git/branches` lists an `origin/<name>` branch only when no local `<name>` exists.

Stage and unstage work on whole files. A partially staged file appears in both Staged and Changes.
Commit uses only the index, the repository's Git identity, and its normal hooks. No author overrides
or generated trailers are added. Conflicts block commits. Branch switching never forces away changes:
Git refuses switches that would overwrite them. There is no discard/reset/stash/rebase/force-push UI.

Push supports origin only. It targets the current branch's origin upstream (or the same branch name
when publishing). The server reads origin's actual default ref before a push. A push to that branch,
or an unknown default, returns 409 `confirm-default:` until the user explicitly confirms. The displayed branch and head SHA are required and rechecked. Push sends the pinned SHA, not a moving HEAD. No force flag
is used. Repository branch rules still apply. After a successful GitHub push, the UI offers a compare
link to open a PR. Opening the Pull requests tab refreshes its list.

A per-machine/repository mutation lock rejects overlapping actions with 409. External Git processes
and agents can still change files; refresh after such changes. The UI warns when the session is active.
Commands are argument arrays, not shell strings. Prompts are disabled, including SSH batch mode. The
main host can use its SSH agent; workers currently supply PATH and HOME only, so use a credential helper
or noninteractive SSH key there. Missing worker agent forwarding is not silently replaced by host auth.

Local commands have a 15-second deadline; fetch/pull/push have 120 seconds. A failed or timed-out write
can have partial effects: refresh and inspect the result before retrying. Output is capped at 4 MiB;
diffs return a `truncated` flag after 512 KiB. Error/summary text and diffs redact URL credentials and
common GitHub token formats. Git authentication errors are not Luna login failures (never HTTP401).

`POST /v1/sessions/:id/submissions/:submission/send-now` accepts `{ content }`. It withdraws only the selected queued input and submits a redirect with a stable replacement request ID. Retries do not duplicate delivery. Already placed messages return 409. Busy-input safety guards still apply, so blocked redirects remain queued.

### New-session model and reasoning defaults

`GET /v1/models` returns `{ default, defaultThinkingLevel, models, refresh }`.
`default` is the default model reference (`{ provider, modelId }` or `null`).
`defaultThinkingLevel` is the live reasoning default used when creating a session (`off` if unset).
Before the first message, the web composer displays these defaults unless the user has selected a draft override.
Refreshing the catalog preserves draft overrides and does not change an existing session's reasoning level.

### Ordered pinned models

`pinnedModels` is an ordered array of unique `provider/modelId` strings (default `[]`).
Clients using the same daemon share this list through its configuration file. Separate daemons do not automatically replicate configuration.
The picker refreshes pins when opened. Pin, unpin, and move actions save immediately.
Existing browser pins are imported once after a successful save: shared order stays unchanged, and missing local pins append in local order.

- `GET /v1/models/pins` returns `{ pins: string[] }`.
- `POST /v1/models/pins` returns the saved list. Send `{ action: "import", pins: string[] }`, `{ action: "toggle", key: string }`, or `{ action: "move", key: string, direction: -1 | 1 }`. Mutations use the latest config to preserve unrelated settings.

## Android push (Firebase Cloud Messaging)

The daemon pushes to the Android app when a running session finishes, fails, hits a limit, or needs input or approval. A cron run pushes only on failure.

1. In a Firebase project, add an Android app with package name `dev.luna.mobile`. Save its `google-services.json` at `~/.luna/android/google-services.json`, outside the checkout. Gradle uses this default from any checkout or worktree. If it is absent, the app builds with push off.
2. To select another file, set `LUNA_GOOGLE_SERVICES` or pass `-Pluna.googleServicesFile=/absolute/path/google-services.json` to Gradle. The Gradle property wins over the environment variable. Relative overrides resolve from the Android project root (`src-tauri/gen/android`), not `app/`. An explicitly selected file must be nonempty as a path, readable, and a regular file; invalid JSON or a mismatched package fails Firebase processing. There is no fallback to a checkout-local JSON file and no private Gradle init hook is needed.
3. Create a service-account key (Project settings > Service accounts). Set `push.serviceAccountFile` to its path. Keep it outside the repo; it is separate from the Android client JSON.
4. Rebuild the APK. The app registers its token with `POST /v1/push/devices` after each login.

To verify Firebase resource processing without building Rust or an APK:

```sh
cd src-tauri/gen/android
./gradlew --no-daemon :app:processArmDebugGoogleServices :app:processUniversalDebugGoogleServices
```

These tasks are registered only when a Firebase config is selected. Generated Android resources stay in Gradle's build directory; the deployment JSON is never copied into the checkout.

`GET /v1/push` reports whether push is enabled. Device tokens are in `<dataDir>/push-devices.json`.
