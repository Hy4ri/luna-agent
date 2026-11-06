// Session-owned terminals. A terminal outlives any browser connection: clients attach, get the recent output replayed, and detach again.
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { defaultShell, shellEnvironment, type PtyLauncher, type PtyProcess } from "./pty-host.js";

export type TerminalOwner = "user" | "agent";

export interface TerminalInfo {
  id: string;
  session: number;
  owner: TerminalOwner;
  /** Worker id, or null for the main host. */
  worker: number | null;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  status: "running" | "ended";
  exitCode: number | null;
  /** Why the terminal ended. Absent while it runs. */
  endReason?: string;
  createdAt: number;
}

export interface TerminalListener {
  data(chunk: Buffer): void;
  exit(info: TerminalInfo): void;
  /** The terminal was removed from the registry. No more events follow. */
  closed(): void;
}

export class TerminalError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 503) { super(message); }
}

export interface RegistryOptions {
  launcher: PtyLauncher;
  maxPerSession?: number;
  ringBytes?: number;
  /** Ended terminals kept per session so the user can read their last output. */
  maxEndedPerSession?: number;
  env?: NodeJS.ProcessEnv;
}

interface Entry {
  info: TerminalInfo;
  proc?: PtyProcess;
  ring: Buffer[];
  ringBytes: number;
  listeners: Set<TerminalListener>;
}

const clamp = (n: number, min: number, max: number, fallback: number) =>
  Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;

export class TerminalRegistry {
  private entries = new Map<string, Entry>();
  private pending = new Map<number, number>();
  private readonly maxPerSession: number;
  private readonly ringLimit: number;
  private readonly maxEnded: number;

  constructor(private readonly options: RegistryOptions) {
    this.maxPerSession = options.maxPerSession ?? 8;
    this.ringLimit = options.ringBytes ?? 2 * 1024 * 1024;
    this.maxEnded = options.maxEndedPerSession ?? 8;
  }

  private live(session: number) {
    let n = this.pending.get(session) ?? 0;
    for (const e of this.entries.values()) if (e.info.session === session && e.info.status === "running") n++;
    return n;
  }

  async create(input: { session: number; owner?: TerminalOwner; worker: number | null; cwd: string; cols?: number; rows?: number }): Promise<TerminalInfo> {
    if (this.live(input.session) >= this.maxPerSession)
      throw new TerminalError(`This session already has ${this.maxPerSession} running terminals. Close one first.`, 409);
    const cols = clamp(input.cols ?? 80, 2, 500, 80), rows = clamp(input.rows ?? 24, 1, 300, 24);
    const { file, args } = defaultShell(this.options.env);
    this.pending.set(input.session, (this.pending.get(input.session) ?? 0) + 1);
    let proc: PtyProcess;
    try {
      proc = await this.options.launcher(input.worker, { file, args, cwd: input.cwd, env: shellEnvironment(this.options.env), cols, rows });
    } catch (e) {
      throw new TerminalError(`Could not start a terminal: ${(e as Error).message}`, 503);
    } finally {
      const left = (this.pending.get(input.session) ?? 1) - 1;
      if (left > 0) this.pending.set(input.session, left); else this.pending.delete(input.session);
    }
    const entry: Entry = {
      info: { id: randomUUID(), session: input.session, owner: input.owner ?? "user", worker: input.worker, cwd: input.cwd, shell: basename(file), cols, rows, status: "running", exitCode: null, createdAt: Date.now() },
      proc, ring: [], ringBytes: 0, listeners: new Set(),
    };
    this.entries.set(entry.info.id, entry);
    proc.onData(chunk => this.output(entry, chunk));
    proc.onExit(exit => this.end(entry, exit.exitCode, exit.signal ? `Killed by signal ${exit.signal}.` : undefined));
    this.pruneEnded(input.session);
    return { ...entry.info };
  }

  private output(entry: Entry, chunk: Buffer) {
    if (entry.info.status !== "running") return;
    entry.ring.push(chunk);
    entry.ringBytes += chunk.length;
    while (entry.ringBytes > this.ringLimit && entry.ring.length > 1) entry.ringBytes -= entry.ring.shift()!.length;
    for (const l of entry.listeners) l.data(chunk);
  }

  private end(entry: Entry, exitCode: number | null, reason?: string) {
    if (entry.info.status === "ended") return;
    entry.info.status = "ended";
    entry.info.exitCode = exitCode;
    if (reason) entry.info.endReason = reason;
    entry.proc = undefined;
    for (const l of entry.listeners) l.exit({ ...entry.info });
  }

  private pruneEnded(session: number) {
    const ended = [...this.entries.values()].filter(e => e.info.session === session && e.info.status === "ended");
    for (const e of ended.slice(0, Math.max(0, ended.length - this.maxEnded))) this.close(e.info.id);
  }

  private entry(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new TerminalError("No such terminal.", 404);
    return e;
  }

  get(id: string): TerminalInfo | undefined { const e = this.entries.get(id); return e && { ...e.info }; }

  list(session: number): TerminalInfo[] {
    return [...this.entries.values()].filter(e => e.info.session === session).map(e => ({ ...e.info }));
  }

  /** Register a listener and return the buffered output. Both happen in one tick, so no byte is lost or sent twice. */
  attach(id: string, listener: TerminalListener): { info: TerminalInfo; replay: Buffer; detach(): void } {
    const e = this.entry(id);
    e.listeners.add(listener);
    return { info: { ...e.info }, replay: Buffer.concat(e.ring), detach: () => { e.listeners.delete(listener); } };
  }

  write(id: string, data: string | Buffer) {
    const e = this.entry(id);
    if (e.proc && e.info.status === "running") e.proc.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    const e = this.entry(id);
    if (!e.proc || e.info.status !== "running") return;
    const c = clamp(cols, 2, 500, e.info.cols), r = clamp(rows, 1, 300, e.info.rows);
    e.proc.resize(c, r);
    e.info.cols = c; e.info.rows = r;
  }

  /** Kill the process if it runs and forget the terminal. Idempotent. */
  close(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    const proc = e.proc;
    this.end(e, null, "Closed.");
    try { proc?.kill(); } catch { /* already gone */ }
    for (const l of e.listeners) l.closed();
    e.listeners.clear();
  }

  closeSession(session: number) {
    for (const e of [...this.entries.values()]) if (e.info.session === session) this.close(e.info.id);
  }

  /** Worker went offline: its terminals can no longer be reached. They stay listed as ended. */
  endWorker(worker: number, reason: string) {
    for (const e of this.entries.values()) if (e.info.worker === worker && e.info.status === "running") {
      const proc = e.proc;
      this.end(e, null, reason);
      try { proc?.kill(); } catch { /* link is down */ }
    }
  }

  closeAll() { for (const id of [...this.entries.keys()]) this.close(id); }
}
