# Native Claude replay transport

Luna's TypeScript provider calls `bridge.py` once per generation. The bridge uses
Python's standard library and the MIT-licensed Hermes DirectSDK transport.
It does not import Hermes core or use Hermes configuration or credentials.

## Upstream provenance

Source: [NousResearch/hermes-official-plugins, claude-subscription-directsdk](https://github.com/NousResearch/hermes-official-plugins/tree/f98c0999c6dd4e59680addc8f3480208018ab5b0/claude-subscription-directsdk).
Pinned commit: `f98c0999c6dd4e59680addc8f3480208018ab5b0`.
License: `UPSTREAM_LICENSE` (MIT, Nous Research and contributors).

These files are copied without changes:

- `model_catalog.py`: pinned native routes and thinking capabilities.
- `inert_mcp.py`: tool inventory without host implementations.
- `evals/directsdk_admission.py` and `evals/directsdk_cache_wire.py`: offline native qualification.

Two transport files have deliberate Luna changes, marked `Luna-local change`:

- `admission.py`: a queried tool-result mismatch returns HTTP 400 before forwarding.
  Upstream records the mismatch and forwards the native frame. Luna must not accept
  synthetic denials as host results.
- `directsdk.py`: native token/context-limit stop reasons take precedence over tool calls.
  A complete first call does not make the rest of a truncated batch safe to execute.
  The remaining structured replay, signed carriers, stable session/cwd, and process
  ownership code is unchanged.

Local files:

- `bridge.py`: one stdin JSON request; stdout JSONL deltas, then one completed response.
- `directsdk_setup.py`: minimal executable/config-directory/traffic helpers, without Hermes setup imports.
- `agent/reasoning_effort.py`: standalone compatibility helper for the upstream lazy reasoning import.
- `test_transport.py`: offline replay, bridge, cancellation, and relay regression tests.

Keep the `mcp__hermes__` wire prefix. It is private to this transport. DirectSDK
maps it back to Luna's tool names. Changing it also changes signed replay content.

## Safety and qualification

- Python 3.10+ and the official Claude CLI are required.
- Replay acknowledgments are version-sensitive. A missing zero-turn acknowledgment fails the request.
- Historical user frames use `shouldQuery: false`; only the newest user/tool-result frame queries.
- Each request gets an inert MCP inventory and a one-use loopback HTTP admission.
- Built-in tools, native compaction, session persistence, and automatic retries are disabled.
- Inherited API-key/backend overrides fail closed. Normal CLI login and OAuth-token configuration remain available.
- SIGTERM unwinds the bridge; DirectSDK cancels and reaps its owned CLI process group.
- The final response and token usage come from the relay's completed upstream capture.
- Cache-prefix continuity is testable offline. Actual vendor cache hits and subscription savings require separate live measurements.

Run from the repository root:

```sh
pnpm run verify:claude-cli:budget
pnpm run verify:claude-cli:native
pnpm run verify:claude-cli:wire /absolute/path/to/claude
```

The wire check uses the real executable with temporary configuration, fake
credentials, and a synthetic loopback peer. Its token usage is synthetic.
It also sets outbound proxies to a closed loopback port.
The authenticated `verify:claude-cli:live` script is separate and opt-in.
