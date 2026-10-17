"""Minimal setup and compatibility helpers for Luna's vendored DirectSDK client.

Provides the exact interface directsdk.py imports from directsdk_setup without
pulling in Hermes CLI or profile configuration.
"""
import os
import shutil

INSTALL_HINT = (
    "Claude Code is not installed (no `claude` on PATH or in the usual install directories). "
    "Install it with `npm install -g @anthropic-ai/claude-code` or set LUNA_CLAUDE_EXECUTABLE to the binary."
)
LOGIN_HINT = "Claude Code is installed but not logged in. Run `claude auth login`, then retry."
LOGGED_OUT_HINT = (
    "Claude Code is installed but has no usable login in the environment Luna runs it in. "
    "Run `claude auth login`, set CLAUDE_CODE_OAUTH_TOKEN in Luna's environment, or point "
    "CLAUDE_CONFIG_DIR at a logged-in directory."
)

_HOME_PREFIXES = (".local/bin", ".claude/local", "bin", ".npm-global/bin", ".bun/bin", ".volta/bin")
_SYSTEM_PREFIXES = ("/opt/homebrew/bin", "/usr/local/bin")

ALWAYS_QUIET = {
    "DISABLE_AUTOUPDATER": "1",
    "DISABLE_FEEDBACK_COMMAND": "1",
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1",
}
QUIET_TRAFFIC = {
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "DISABLE_TELEMETRY": "1",
    "DISABLE_ERROR_REPORTING": "1",
}


def _install_prefixes(env):
    home = env.get("USERPROFILE" if os.name == "nt" else "HOME")
    prefixes = [os.path.join(home, prefix) for prefix in _HOME_PREFIXES] if home else []
    return prefixes + ([] if os.name == "nt" else list(_SYSTEM_PREFIXES))


def _resolve(command, env):
    command = list(command) if command else [env.get("LUNA_CLAUDE_EXECUTABLE") or "claude"]
    head = command[0]
    exe = head if os.path.isabs(head) and os.access(head, os.X_OK) else shutil.which(head, path=env.get("PATH") or os.defpath)
    if not exe and head == "claude":
        exe = shutil.which(head, path=os.pathsep.join(_install_prefixes(env)))
    return ([exe] + command[1:]) if exe else None


def apply_config_dir(env):
    config = env.get("CLAUDE_CONFIG_DIR")
    if config:
        env["CLAUDE_CONFIG_DIR"] = os.path.expanduser(config)
    return env


def apply_traffic_policy(env, telemetry=None):
    env.update(ALWAYS_QUIET)
    env["ENABLE_CLAUDEAI_MCP_SERVERS"] = "0"
    # Luna disables nonessential traffic by default unless telemetry is explicitly enabled
    if not telemetry:
        env.update(QUIET_TRAFFIC)
    return env
