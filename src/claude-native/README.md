# Native Claude replay transport

Luna's `claude-cli` provider drives the official Claude Code CLI in-process. No Python or separate agent installation is used.
One generation is one CLI process group and one admitted upstream Messages request.

## Files

- `history.ts`: Luna transcript to native stream-json frames, signed carrier restore, session id, model routes, tool body.
- `admission.ts`: one-use loopback HTTP relay. It forwards one `/v1/messages` POST, captures the SSE answer,
  and moves cache breakpoints onto content the next request replays unchanged.
- `transport.ts`: environment guard, CLI spawn, frame replay, event loop, final response.
- `billing.ts`: opt-in paid usage credits and non-retryable billing errors.
- `status.ts`: bounded, cancellable local `claude auth status` checks without inference.
- `inert-mcp.mjs`: tool inventory without implementations. Luna executes every tool.
- `types.ts`: shared shapes.

## Upstream provenance

Ported from Nous Research’s `claude-subscription-directsdk` plugin,
pinned commit `f98c0999c6dd4e59680addc8f3480208018ab5b0`. License: `UPSTREAM_LICENSE` (MIT, Nous Research and contributors).
Windows support, the upstream client API, and request fields Luna never sends were dropped.

The billing guard and chronological tool-change design also draw on
[earendil-works/pi-claude-code](https://github.com/earendil-works/pi-claude-code/tree/70abb65186592ca788b29b3db22c3160d629c41f),
pinned commit `70abb65186592ca788b29b3db22c3160d629c41f`.
Its MIT notice is retained in `PI_CLAUDE_CODE_LICENSE`. The installed pi-ai Anthropic contract determines
native inline-tool blocks and model reasoning support; the older extension is not the wire-protocol authority.

Deliberate Luna changes, kept from the Python version:

- A queried tool-result mismatch returns HTTP 400 before forwarding. Luna never accepts synthetic denials as host results.
- Native token/context-limit stop reasons take precedence over tool calls. A truncated batch never executes.

New conversations use the `luna` MCP server and `mcp__luna__` wire prefix.
Each new native carrier records its wire prefix. For older carriers without this marker, Luna reads
the namespace from their stored native tool-use names and selects the matching MCP server.
Signed native messages are never renamed. Conflicting namespaces fail before spawning the CLI.
The carrier type and temporary-directory names remain unchanged.
The session id and native cwd must stay stable for one conversation; both sit in the cached prompt prefix.

## Safety and qualification

- Historical user frames use `shouldQuery: false`; only the newest user/tool-result frame queries.
- Replay acknowledgments are version-sensitive. A missing zero-turn acknowledgment fails the request.
- Built-in tools, native compaction, session persistence, and automatic retries are disabled.
- Inherited API-key/backend overrides fail closed. Normal CLI login and OAuth-token configuration remain available.
- Abort kills the owned CLI process group before the request rejects.
- The final response and token usage come from the relay's completed upstream capture.
- Reported paid overage stops the loop before tool execution unless `LUNA_CLAUDE_ALLOW_USAGE_CREDITS=1`.
  Completed response tokens and the native USD estimate remain recorded. This cannot undo the first charge;
  disable extra usage in the Claude account to prevent it.
- Availability uses `claude auth status`; it does not submit a model prompt or copy credential files.
- Models advertise only catalogued thinking support. Thinking off is explicit when supported, not an inherited CLI default.
  Models that require thinking clamp off to their lowest supported level.
- One fresh CLI process remains the rule. No warm-process reuse or saved native transcript is introduced.
- There is no input-size guard. The runtime's compaction owns history size.

Run `pnpm run typecheck` from the repository root. Repository policy forbids test files and harnesses;
compiler checks do not prove live vendor behavior. The historical `verify:claude-cli:*` scripts are not shipped.
Authenticated inference requires separate approval and is not part of the compiler gate.
