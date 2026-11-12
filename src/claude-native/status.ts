// Local auth inspection only: never sends a model prompt or reads credential files.
import { claudeControlOptions, INSTALL_HINT } from "./transport.js";

export interface ClaudeLoginStatus {
  loggedIn: boolean;
  plan?: string;
}

interface InspectionResult {
  status: ClaudeLoginStatus;
  cacheable: boolean;
}

const CACHE_TTL_MS = 60_000;
/** Test hook: shifts the cache clock. */
let clockOffset = 0;
export function advanceClaudeStatusClockForTest(ms: number): void { clockOffset += ms; }
const now = () => Date.now() + clockOffset;
let cacheGeneration = 0;
let cachedEntry: { status: ClaudeLoginStatus; expiresAt: number; generation: number } | null = null;
let inflightFlight: { promise: Promise<ClaudeLoginStatus>; generation: number } | null = null;

export function invalidateClaudeLoginStatus(): void {
  cacheGeneration++;
  cachedEntry = null;
  inflightFlight = null;
}

export async function readClaudeLoginStatusCached(signal?: AbortSignal): Promise<ClaudeLoginStatus> {
  signal?.throwIfAborted();
  if (cachedEntry && cachedEntry.generation === cacheGeneration && cachedEntry.expiresAt > now()) {
    return cachedEntry.status;
  }
  // Expired but same generation (no login change since): serve the last status and refresh in the background.
  // The `claude auth status` spawn costs ~350-400 ms, and every /v1/models request after 60 s idle waited for it.
  const stale = cachedEntry && cachedEntry.generation === cacheGeneration ? cachedEntry.status : undefined;

  if (!inflightFlight || inflightFlight.generation !== cacheGeneration) {
    const flightGen = cacheGeneration;
    const promise = (async () => {
      try {
        const inspected = await inspectClaudeLoginStatus();
        if (flightGen === cacheGeneration && inspected.cacheable) {
          cachedEntry = { status: inspected.status, expiresAt: now() + CACHE_TTL_MS, generation: flightGen };
        } else if (flightGen === cacheGeneration) {
          // A failed inspection must not leave an old status to be served stale.
          cachedEntry = null;
        }
        return inspected.status;
      } finally {
        if (inflightFlight?.generation === flightGen) {
          inflightFlight = null;
        }
      }
    })();
    inflightFlight = { promise, generation: flightGen };
  }

  const currentPromise = inflightFlight.promise;
  if (stale) {
    currentPromise.catch(() => {});
    return stale;
  }
  if (!signal) {
    return currentPromise;
  }

  return new Promise<ClaudeLoginStatus>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Claude login check cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    currentPromise.then(
      (res) => {
        signal.removeEventListener("abort", onAbort);
        resolve(res);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

async function inspectClaudeLoginStatus(signal?: AbortSignal): Promise<InspectionResult> {
  signal?.throwIfAborted();
  let control: ReturnType<typeof claudeControlOptions>;
  try { control = claudeControlOptions(); }
  catch (error) {
    if (error instanceof Error && error.message === INSTALL_HINT) {
      return { status: { loggedIn: false }, cacheable: true };
    }
    throw error;
  }
  const { executable, env } = control;
  let child: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    child = Bun.spawn([executable, "auth", "status"], {
      env,
      detached: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return { status: { loggedIn: false }, cacheable: false };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<InspectionResult>((resolve, reject) => {
      let output = "", bytes = 0;
      const uncacheableFailure = () => resolve({ status: { loggedIn: false }, cacheable: false });
      abort = () => reject(signal?.reason ?? new Error("Claude login check cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      timer = setTimeout(uncacheableFailure, 10_000);
      void (async () => {
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            bytes += Buffer.byteLength(chunk);
            if (bytes > 1024 * 1024) { uncacheableFailure(); return; }
            output += chunk;
          }
          output += decoder.decode();
          const code = await child.exited;
          if (code !== 0) { uncacheableFailure(); return; }
          const value: unknown = JSON.parse(output);
          if (value === null || typeof value !== "object" || Array.isArray(value)) {
            uncacheableFailure();
            return;
          }
          const status = value as Record<string, unknown>;
          resolve({
            status: {
              loggedIn: status.loggedIn === true,
              ...(typeof status.subscriptionType === "string" && status.subscriptionType
                ? { plan: status.subscriptionType } : {}),
            },
            cacheable: true,
          });
        } catch {
          uncacheableFailure();
        } finally {
          reader.releaseLock();
        }
      })();
    });
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    // Kill only the process group owned by this call, before resolving cancellation/timeouts.
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
    }
    await child.stdout.cancel().catch(() => {});
    await child.exited.catch(() => {});
  }
}

export async function readClaudeLoginStatus(signal?: AbortSignal): Promise<ClaudeLoginStatus> {
  const result = await inspectClaudeLoginStatus(signal);
  return result.status;
}
