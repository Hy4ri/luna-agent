# Security Policy

## Supported Versions

Security fixes apply to the `main` branch and the latest release.

## Reporting a Vulnerability

Do not open a public GitHub issue for security bugs.

Use GitHub's private vulnerability reporting instead:
1. Open the **Security** tab in `Hy4ri/luna-agent`.
2. Click **Report a vulnerability**.
3. Include steps to reproduce, the affected component, and any suggested fix.

## Threat Model

Luna is a local-first agent daemon. By design, it:
- runs shell commands on the host and connected workers
- drives a local browser session
- stores provider OAuth tokens and reads API keys from the environment

Because the daemon exposes full agent control over HTTP and WebSocket (default port `8787`), never expose it to a network without authentication.

By default, `bindRefusal` in `src/config.ts` refuses to start the daemon on a non-loopback host (`LUNA_HOST` other than `127.0.0.1` / `localhost` / `::1`) unless `LUNA_TOKEN` is set. Keep `LUNA_TOKEN` in the environment (not in `luna.config.json`), and use TLS or a private tunnel (such as Tailscale) if you access the daemon remotely.
