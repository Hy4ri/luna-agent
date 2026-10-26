// Authenticated SSE with one owned connection, cancellable retries, and no message submission on reconnect.
import { reportConnectionFailure } from "./connections";
import type { ApiOptions, HttpError } from "./api";

export interface FeedOptions {
  path: string;
  api: (path: string, init?: ApiOptions) => Promise<Response>;
  beforeConnect?: (signal: AbortSignal) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onEvent: (type: string, data: any) => unknown;
  onDisconnect?: (error: HttpError) => boolean | void;
}
export interface Feed { stop(): void; reconnect(onlyIfStale?: boolean): void }

// History fetch gets 30s. Stream header + first parsed frame gets 10s. Idle stream gets 30s.
const HISTORY_TIMEOUT = 30000, CONNECT_TIMEOUT = 10000, IDLE_TIMEOUT = 30000, FRESH_FOR = 15000;
const DEBOUNCE_FAILURES = 3, DEBOUNCE_TIME_MS = 8000;

export function watchFeed({ path, api, beforeConnect, onEvent, onDisconnect }: FeedOptions): Feed {
  let stopped = false, generation = 0, delay = 500;
  let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let connecting = false, lastEventAt = 0;
  let consecutiveFailures = 0, firstFailureAt = 0;
  const failureSource = Symbol(path);

  function recordTransportFailure() {
    consecutiveFailures++;
    const now = Date.now();
    if (!firstFailureAt) firstFailureAt = now;
    if (consecutiveFailures >= DEBOUNCE_FAILURES || now - firstFailureAt >= DEBOUNCE_TIME_MS) {
      reportConnectionFailure(failureSource, true);
    }
  }

  function resetTransportFailures() {
    consecutiveFailures = 0;
    firstFailureAt = 0;
    reportConnectionFailure(failureSource, false);
  }

  async function connect() {
    const own = ++generation;
    controller?.abort(); clearTimeout(timer);
    const abort = controller = new AbortController();
    connecting = true;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined, timedOut = false;
    const arm = (ms: number) => {
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        if (stopped || own !== generation) return;
        timedOut = true;
        abort.abort();
      }, ms);
    };

    try {
      if (beforeConnect) {
        arm(HISTORY_TIMEOUT);
        await beforeConnect(abort.signal);
        if (stopped || own !== generation) return;
      }

      // Stream connection and first frame deadline: 10s. Timeout API disabled for SSE.
      arm(CONNECT_TIMEOUT);
      const response = await api(path, {
        signal: abort.signal,
        headers: { accept: "text/event-stream" },
        cache: "no-store",
        timeoutMs: 0,
      });
      if (!response.ok) throw Object.assign(new Error((await response.json().catch(() => ({}))).error || response.statusText), { status: response.status });
      reader = response.body!.getReader();
      const decoder = new TextDecoder(); let buffer = "";
      while (!stopped && own === generation) {
        const { value, done } = await reader.read();
        if (done) throw new Error("Connection closed");
        buffer += decoder.decode(value, { stream: true });
        // Normalize after buffering: a CRLF sequence can cross network chunks.
        buffer = buffer.replace(/\r\n/g, "\n");
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const type = frame.match(/^event:\s*(.*)$/m)?.[1];
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
          if (!type || !data || stopped || own !== generation) continue;
          const event = JSON.parse(data);
          resetTransportFailures();
          connecting = false; lastEventAt = Date.now();
          arm(IDLE_TIMEOUT); delay = 500;
          await onEvent(type, event);
        }
      }
    } catch (err) {
      if (stopped || own !== generation || (abort.signal.aborted && !timedOut)) return;
      connecting = false; lastEventAt = 0;
      const httpErr = err as HttpError;
      const isAuthOrNotFound = httpErr.status === 401 || httpErr.status === 404 || httpErr.message === "unauthorized";
      if (!isAuthOrNotFound && (timedOut || !httpErr.status || httpErr.status >= 500 || httpErr.status === 408)) {
        recordTransportFailure();
      }
      const error = timedOut ? new Error("Connection timed out") : httpErr;
      if (onDisconnect?.(error) === false || error.message === "unauthorized") { stopped = true; reportConnectionFailure(failureSource, false); return; }
      timer = setTimeout(connect, delay); delay = Math.min(delay * 2, 5000);
    } finally {
      clearTimeout(deadline);
      await reader?.cancel().catch(() => {});
    }
  }
  void connect();
  return {
    stop() { stopped = true; reportConnectionFailure(failureSource, false); generation++; clearTimeout(timer); controller?.abort(); },
    reconnect(onlyIfStale = false) {
      if (stopped || (onlyIfStale && (connecting || Date.now() - lastEventAt < FRESH_FOR))) return;
      delay = 500;
      void connect();
    },
  };
}
