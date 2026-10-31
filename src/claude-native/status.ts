// Local auth inspection only: never sends a model prompt or reads credential files.
import { spawn } from "node:child_process";
import { claudeControlOptions, INSTALL_HINT } from "./transport.js";

export interface ClaudeLoginStatus {
  loggedIn: boolean;
  plan?: string;
}

export async function readClaudeLoginStatus(signal?: AbortSignal): Promise<ClaudeLoginStatus> {
  signal?.throwIfAborted();
  let control: ReturnType<typeof claudeControlOptions>;
  try { control = claudeControlOptions(); }
  catch (error) {
    if (error instanceof Error && error.message === INSTALL_HINT) return { loggedIn: false };
    throw error;
  }
  const { executable, env } = control;
  const child = spawn(executable, ["auth", "status"], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise<void>(resolve => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<ClaudeLoginStatus>((resolve, reject) => {
      let output = "", bytes = 0;
      const unavailable = () => resolve({ loggedIn: false });
      abort = () => reject(signal?.reason ?? new Error("Claude login check cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      timer = setTimeout(unavailable, 10_000);
      child.once("error", unavailable);
      // Do not expose stderr, which can contain account or environment details.
      child.stderr.resume();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024 * 1024) { unavailable(); return; }
        output += chunk;
      });
      child.once("close", code => {
        if (code !== 0) { unavailable(); return; }
        try {
          const value: unknown = JSON.parse(output);
          if (value === null || typeof value !== "object" || Array.isArray(value)) { unavailable(); return; }
          const status = value as Record<string, unknown>;
          resolve({ loggedIn: status.loggedIn === true,
            ...(typeof status.subscriptionType === "string" && status.subscriptionType
              ? { plan: status.subscriptionType } : {}) });
        } catch { unavailable(); }
      });
    });
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    // Kill only the process group owned by this call, before resolving cancellation/timeouts.
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
    }
    child.stdout.destroy();
    child.stderr.destroy();
    await closed;
  }
}
