// Reuse Codex's ChatGPT login. Codex owns token rotation and persistence; Luna never rewrites its auth file.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexImageCredential { accessToken: string; accountId?: string; residency?: string }
export interface CodexImageAuth {
  is_available(): boolean;
  resolve(signal: AbortSignal): Promise<CodexImageCredential>;
}
export class CodexImageAuthError extends Error {
  constructor(readonly error_type: string, message: string) { super(message); }
}
function readCredential(home: string): (CodexImageCredential & { expires: number }) | undefined {
  try {
    const file = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
    if (file.auth_mode !== undefined && file.auth_mode !== "chatgpt") return undefined;
    const accessToken = file.tokens?.access_token;
    if (typeof accessToken !== "string" || !accessToken) return undefined;
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"));
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return undefined;
    const auth = claims["https://api.openai.com/auth"] ?? {};
    const accountId = file.tokens.account_id ?? auth.chatgpt_account_id;
    if (typeof accountId !== "string" || !accountId || auth.chatgpt_account_id && auth.chatgpt_account_id !== accountId) return undefined;
    const residency = auth.chatgpt_data_residency ?? auth.chatgpt_compute_residency;
    return { accessToken, accountId, expires: claims.exp * 1000, ...(typeof residency === "string" && residency.trim() ? { residency: residency.trim() } : {}) };
  } catch { return undefined; }
}

/** Official account/read RPC refreshes credentials without a model turn or an image request. */
export async function refreshCodexImageAuth(home: string, command: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let child: Bun.Subprocess<"pipe", "pipe", "ignore">;
    try {
      child = Bun.spawn([command, "app-server", "--listen", "stdio://"], {
        env: { ...process.env, CODEX_HOME: home }, stdin: "pipe", stdout: "pipe", stderr: "ignore", detached: true,
      });
    } catch {
      reject(new Error("Could not start Codex for credential refresh."));
      return;
    }
    let buffer = "", total = 0, settled = false, error: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (kind: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, kind); } catch { /* Already exited. */ } } };
    const finish = (failure?: Error) => {
      if (settled) return;
      settled = true; error = failure;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 1000);
    };
    const abort = () => finish(new Error("Codex credential refresh interrupted."));
    const send = (value: unknown) => {
      try {
        child.stdin.write(JSON.stringify(value) + "\n");
      } catch {
        finish(new Error("Codex auth channel closed."));
      }
    };
    void child.exited.then(() => {
      signal.removeEventListener("abort", abort); clearTimeout(killTimer);
      if (!settled) error = new Error("Codex closed before credential refresh completed.");
      if (error) reject(error); else resolve();
    }, () => {
      signal.removeEventListener("abort", abort); clearTimeout(killTimer);
      if (!settled) error = new Error("Could not start Codex for credential refresh.");
      if (error) reject(error); else resolve();
    });
    void (async () => {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || settled) break;
          const chunk = decoder.decode(value, { stream: true });
          total += Buffer.byteLength(chunk); buffer += chunk;
          if (total > 1024 * 1024) { finish(new Error("Codex auth response exceeds its limit.")); return; }
          for (;;) {
            const end = buffer.indexOf("\n"); if (end < 0) break;
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            let message: any;
            try { message = JSON.parse(line); } catch { finish(new Error("Invalid Codex auth response.")); return; }
            if (message.id !== 1 && message.id !== 2) continue;
            if (message.error) { finish(new Error("Codex rejected credential refresh.")); return; }
            if (message.id === 1) {
              send({ method: "initialized" });
              send({ id: 2, method: "account/read", params: { refreshToken: true } });
            } else {
              finish(message.result?.account?.type === "chatgpt" ? undefined : new Error("Codex is not signed in with ChatGPT."));
              return;
            }
          }
        }
      } catch {
        finish(new Error("Codex auth channel closed."));
      } finally {
        reader.releaseLock();
      }
    })();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else send({ id: 1, method: "initialize", params: { clientInfo: { name: "luna-pi", version: "1.0.0" } } });
  });
}
const refreshing = new Map<string, Promise<void>>();
function waitForRefresh(promise: Promise<void>, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(new Error("Interrupted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export function createCodexImageAuth(options: {
  config: () => { codexHome?: string; codexCommand?: string };
  refresh?: typeof refreshCodexImageAuth;
}): CodexImageAuth {
  const settings = () => {
    const cfg = options.config();
    return { home: cfg.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"), command: cfg.codexCommand ?? "codex" };
  };
  return {
    is_available() { return !!readCredential(settings().home); },
    async resolve(signal) {
      signal.throwIfAborted();
      const { home, command } = settings();
      const before = readCredential(home);
      if (!before) throw new CodexImageAuthError("auth_required", "Sign in with ChatGPT using codex login. API keys and Luna's separate chat OAuth login are not used.");
      if (before.expires > Date.now() + 60_000) return before;
      const id = JSON.stringify([home, command]);
      let promise = refreshing.get(id);
      if (!promise) {
        // Once rotation starts, finish persistence even if the image call is cancelled.
        promise = (options.refresh ?? refreshCodexImageAuth)(home, command, AbortSignal.timeout(45_000)).finally(() => refreshing.delete(id));
        refreshing.set(id, promise);
      }
      try { await waitForRefresh(promise, signal); }
      catch { signal.throwIfAborted(); throw new CodexImageAuthError("auth_refresh_failed", "Codex could not refresh the ChatGPT login. Run codex login, then try again."); }
      signal.throwIfAborted();
      const after = readCredential(home);
      if (!after || after.accountId !== before.accountId) throw new CodexImageAuthError("auth_changed", "Codex account changed during refresh. No image was requested.");
      if (after.expires <= Date.now() + 60_000) throw new CodexImageAuthError("auth_refresh_failed", "Codex did not save a usable refreshed login. Run codex login.");
      return after;
    },
  };
}
