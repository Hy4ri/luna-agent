# Native Claude replay transport

Luna's `claude-cli` provider drives the official Claude Code CLI in-process. No Python or Hermes install is used.
One generation is one CLI process group and one admitted upstream Messages request.

## Files

- `history.ts`: Luna transcript to native stream-json frames, signed carrier restore, session id, model routes, tool body.
- `admission.ts`: one-use loopback HTTP relay. It forwards one `/v1/messages` POST, captures the SSE answer,
  and moves cache breakpoints onto content the next request replays unchanged.
- `transport.ts`: environment guard, CLI spawn, frame replay, event loop, final response.
- `inert-mcp.mjs`: tool inventory without implementations. Luna executes every tool.
- `types.ts`: shared shapes.

## Upstream provenance

Ported from [NousResearch/hermes-official-plugins, claude-subscription-directsdk](https://github.com/NousResearch/hermes-official-plugins/tree/f98c0999c6dd4e59680addc8f3480208018ab5b0/claude-subscription-directsdk),
pinned commit `f98c0999c6dd4e59680addc8f3480208018ab5b0`. License: `UPSTREAM_LICENSE` (MIT, Nous Research and contributors).
Windows support, the Hermes client API, reasoning effort, and request fields Luna never sends were dropped.

Deliberate Luna changes, kept from the Python version:

- A queried tool-result mismatch returns HTTP 400 before forwarding. Luna never accepts synthetic denials as host results.
- Native token/context-limit stop reasons take precedence over tool calls. A truncated batch never executes.

Keep the `mcp__hermes__` wire prefix. It is private to this transport and part of signed replay content.
The session id and native cwd must stay stable for one conversation; both sit in the cached prompt prefix.

## Safety and qualification

- Historical user frames use `shouldQuery: false`; only the newest user/tool-result frame queries.
- Replay acknowledgments are version-sensitive. A missing zero-turn acknowledgment fails the request.
- Built-in tools, native compaction, session persistence, and automatic retries are disabled.
- Inherited API-key/backend overrides fail closed. Normal CLI login and OAuth-token configuration remain available.
- Abort kills the owned CLI process group before the request rejects.
- The final response and token usage come from the relay's completed upstream capture.
- There is no input-size guard. The runtime's compaction owns history size.

Run from the repository root:

```sh
pnpm run verify:claude-cli:budget
pnpm run verify:claude-cli:native
pnpm run verify:claude-cli:wire /absolute/path/to/claude
```

The wire check uses the real executable with temporary configuration, fake credentials, and a synthetic
loopback peer. Its token usage is synthetic. Outbound proxies point at a closed loopback port.
The authenticated `verify:claude-cli:live` script is separate and opt-in.
