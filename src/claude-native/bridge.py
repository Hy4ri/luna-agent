#!/usr/bin/env python3
"""One request on stdin; text/thinking deltas and one complete response on stdout.

Uses only the Python standard library and the vendored Hermes transport. No
Hermes installation, profile, credentials, or Python Agent SDK is consulted.
"""
import json
import signal
import sys

from directsdk import Client


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def plain(value):
    if hasattr(value, "model_dump"):
        return value.model_dump()
    return value


def interrupted(signum, _frame):
    # Unwind locks and the iterator before client.close() runs in finally.
    raise SystemExit(128 + signum)


def main():
    client = None
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict) or not isinstance(payload.get("request"), dict):
            raise ValueError("Expected a Claude bridge request object")
        command = payload.get("command")
        if not isinstance(command, str) or not command.strip():
            raise ValueError("Expected a nonempty Claude executable path")
        # No explicit env= injection: DirectSDK's inherited-auth conflict guard
        # must remain active. CLAUDE_CODE_OAUTH_TOKEN and CLAUDE_CONFIG_DIR work.
        client = Client(command=[command])
        request = dict(payload["request"], stream=True)
        response = None
        for chunk in client.create(**request):
            choices = getattr(chunk, "choices", [])
            delta = getattr(choices[0], "delta", None) if choices else None
            if delta:
                text = getattr(delta, "content", None)
                if text:
                    emit({"type": "delta", "text": text})
                thinking = getattr(delta, "reasoning_content", None)
                if thinking:
                    emit({"type": "thinking", "text": thinking})
            if hasattr(chunk, "_response"):
                if response is not None:
                    raise RuntimeError("Duplicate native completed response")
                response = plain(chunk._response)
        if response is None:
            raise RuntimeError("Native stream ended without a complete response")
        emit({"type": "response", "response": response})
        return 0
    except Exception as error:
        event = {"type": "error", "message": str(error)}
        status = getattr(error, "status_code", None)
        if status is not None:
            event["statusCode"] = status
        emit(event)
        return 1
    finally:
        if client is not None:
            client.close()


if __name__ == "__main__":
    sys.exit(main())
