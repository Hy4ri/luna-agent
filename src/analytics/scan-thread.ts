// Analytics indexing off the main thread. A full re-index (parser version bump) parses every session's entries
// and rewrites its facts: about 11 s of 50-300 ms synchronous blocks on the main thread for 490 sessions, during
// which the daemon answered nothing. This thread scans through its own read-only connection and writes facts
// through its own analytics connection. The main thread only adds the session status between the two phases,
// because that read needs the durable harness.
import { Database } from "bun:sqlite";
import type { AnalyticsScan } from "./types.js";
import { AnalyticsStore } from "./store.js";
import { scanAnalyticsSession } from "./source.js";

type Request =
  | { type: "scan"; seq: number; source: string; analytics: string; id: number }
  | { type: "apply"; seq: number; status: unknown; statusReason: unknown }
  | { type: "drop"; seq: number };
type Reply = { seq: number; found?: boolean; entriesScanned?: number; error?: string };

/** Thread entry. A scan reads one snapshot; its result stays here until the main thread applies or drops it. */
if (!Bun.isMainThread) {
  let source: Database | undefined;
  let store: AnalyticsStore | undefined;
  const held = new Map<number, AnalyticsScan>();
  const port = globalThis as unknown as { onmessage: (event: MessageEvent<Request>) => void; postMessage(message: Reply): void };
  port.onmessage = (event: MessageEvent<Request>) => {
    const message = event.data;
    try {
      if (message.type === "scan") {
        if (!source) {
          source = new Database(message.source, { readonly: true });
          source.exec("PRAGMA busy_timeout=5000; PRAGMA cache_size=-32000; PRAGMA mmap_size=268435456;");
        }
        store ??= new AnalyticsStore(message.analytics);
        source.exec("BEGIN");
        let scan: AnalyticsScan | undefined;
        try {
          scan = scanAnalyticsSession(source, message.id, store.getSession(message.id));
        } finally {
          source.exec("COMMIT");
        }
        if (scan) held.set(message.seq, scan);
        port.postMessage({ seq: message.seq, found: scan !== undefined });
      } else if (message.type === "apply") {
        const scan = held.get(message.seq);
        held.delete(message.seq);
        if (!scan || !store) throw new Error("no held analytics scan");
        scan.session.status = message.status as never;
        scan.session.statusReason = message.statusReason as never;
        store.apply(scan);
        port.postMessage({ seq: message.seq, entriesScanned: scan.entriesScanned });
      } else {
        held.delete(message.seq);
      }
    } catch (error) {
      if (message.type !== "drop") port.postMessage({ seq: message.seq, error: error instanceof Error ? error.message : String(error) });
    }
  };
}

/** Main-thread client. Callers run one session at a time. */
export class AnalyticsScanThread {
  private readonly worker: Worker;
  private seq = 0;
  private readonly waiting = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
  private closed = false;

  constructor(private readonly source: string, private readonly analytics: string) {
    this.worker = new Worker(new URL("./scan-thread.ts", import.meta.url).href);
    this.worker.unref();
    this.worker.onmessage = (event: MessageEvent<Reply>) => {
      const job = this.waiting.get(event.data.seq);
      if (!job) return;
      this.waiting.delete(event.data.seq);
      if (event.data.error !== undefined) job.reject(new Error(event.data.error));
      else job.resolve(event.data);
    };
    this.worker.onerror = (event) => this.fail(new Error(event.message || "analytics scan thread failed"));
  }

  private send(message: Request): Promise<Reply> {
    if (this.closed) return Promise.reject(new Error("analytics scan thread is closed"));
    return new Promise((resolve, reject) => {
      this.waiting.set(message.seq, { resolve, reject });
      this.worker.postMessage(message);
    });
  }

  /** Phase 1. Returns a handle when the conversation exists, undefined when it does not. */
  async scan(id: number): Promise<number | undefined> {
    const seq = ++this.seq;
    const reply = await this.send({ type: "scan", seq, source: this.source, analytics: this.analytics, id });
    return reply.found ? seq : undefined;
  }

  /** Phase 2. Writes the held scan with its status; returns the entries it scanned. */
  async apply(handle: number, status: unknown, statusReason: unknown): Promise<number> {
    return (await this.send({ type: "apply", seq: handle, status, statusReason })).entriesScanned ?? 0;
  }

  drop(handle: number): void {
    if (!this.closed) this.worker.postMessage({ type: "drop", seq: handle } satisfies Request);
  }

  private fail(error: Error): void {
    for (const job of this.waiting.values()) job.reject(error);
    this.waiting.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error("analytics scan thread is closed"));
    this.worker.terminate();
  }
}
