// Session-owned terminals. A terminal outlives any browser connection: clients attach, get the recent output replayed, and detach again.
import { basename } from "node:path";
import { defaultShell, programInvocation, shellEnvironment, type PtyLauncher, type PtyProcess } from "./pty-host.js";
import type { VtFactory, VtModel, VtScreen } from "./vt-model.js";

export type TerminalOwner = "user" | "agent";
/** Who may type. The other side only watches, so input never collides. */
export type TerminalController = "user" | "agent";
/** take: m57 types. give: Luna types. share/unshare: whether Luna can see one of m57's terminals. */
export type ControlAction = "take" | "give" | "share" | "unshare";

export interface TerminalInfo {
  id: string;
  session: number;
  owner: TerminalOwner;
  /** Worker id, or null for the main host. */
  worker: number | null;
  cwd: string;
  shell: string;
  /** The program an agent terminal runs. Absent for an interactive shell. */
  command?: string;
  controller: TerminalController;
  /** Luna can see the terminal. Always true for her own terminals. */
  shared: boolean;
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
  /** Control or sharing changed. */
  control?(info: TerminalInfo): void;
}

export class TerminalError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 503) { super(message); }
}

export interface RegistryOptions {
  launcher: PtyLauncher;
  maxPerSession?: number;
  ringBytes?: number;
  /** Ended terminals kept per session so the user can read their last output. */
  maxEndedPerSession?: number;
  env?: NodeJS.ProcessEnv;
  /** Headless screen parser for terminals Luna reads. Without it, agent terminals and sharing are unavailable. */
  vt?: () => Promise<VtFactory>;
}

interface Entry {
  info: TerminalInfo;
  proc?: PtyProcess;
  ring: Buffer[];
  ringBytes: number;
  listeners: Set<TerminalListener>;
  vt?: VtModel;
  /** Woken on output, exit, and close, for agent waits. */
  watchers: Set<() => void>;
  lastOutput: number;
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

  /** `command` starts one program instead of a shell; the terminal ends when it exits. Agent terminals need a command. */
  async create(input: { session: number; owner?: TerminalOwner; worker: number | null; cwd: string; cols?: number; rows?: number; command?: string }): Promise<TerminalInfo> {
    const owner = input.owner ?? "user";
    if (owner === "agent" && !input.command) throw new TerminalError("An agent terminal runs one program; give its command.", 400);
    if (this.live(input.session) >= this.maxPerSession)
      throw new TerminalError(`This session already has ${this.maxPerSession} running terminals. Close one first.`, 409);
    const cols = clamp(input.cols ?? 80, 2, 500, 80), rows = clamp(input.rows ?? 24, 1, 300, 24);
    const shell = defaultShell(this.options.env);
    const { file, args } = input.command ? programInvocation(shell.file, input.command) : shell;
    this.pending.set(input.session, (this.pending.get(input.session) ?? 0) + 1);
    let proc: PtyProcess;
    let vt: VtModel | undefined;
    try {
      // Load the parser before the program starts, so its first bytes are not lost.
      if (owner === "agent") vt = await (await this.factory())(cols, rows);
      proc = await this.options.launcher(input.worker, { file, args, cwd: input.cwd, env: shellEnvironment(this.options.env), cols, rows, ...(input.command ? { command: input.command } : {}) });
    } catch (e) {
      vt?.dispose();
      if (e instanceof TerminalError) throw e;
      throw new TerminalError(`Could not start a terminal: ${(e as Error).message}`, 503);
    } finally {
      const left = (this.pending.get(input.session) ?? 1) - 1;
      if (left > 0) this.pending.set(input.session, left); else this.pending.delete(input.session);
    }
    const entry: Entry = {
      info: {
        id: crypto.randomUUID(), session: input.session, owner, worker: input.worker, cwd: input.cwd, shell: proc.shell ?? basename(file),
        ...(input.command ? { command: input.command } : {}), controller: owner === "agent" ? "agent" : "user", shared: owner === "agent",
        cols, rows, status: "running", exitCode: null, createdAt: Date.now(),
      },
      proc, ring: [], ringBytes: 0, listeners: new Set(), vt, watchers: new Set(), lastOutput: Date.now(),
    };
    this.entries.set(entry.info.id, entry);
    proc.onData(chunk => this.output(entry, chunk));
    proc.onExit(exit => this.end(entry, exit.exitCode, exit.reason ?? (exit.signal ? `Killed by signal ${exit.signal}.` : undefined)));
    this.pruneEnded(input.session);
    return { ...entry.info };
  }

  private async factory(): Promise<VtFactory> {
    if (!this.options.vt) throw new TerminalError("Luna cannot read terminal screens on this daemon.", 503);
    try { return await this.options.vt(); }
    catch (e) { throw new TerminalError(`The terminal screen parser failed to load: ${(e as Error).message}`, 503); }
  }

  private output(entry: Entry, chunk: Buffer) {
    if (entry.info.status !== "running") return;
    entry.ring.push(chunk);
    entry.ringBytes += chunk.length;
    while (entry.ringBytes > this.ringLimit && entry.ring.length) {
      const first = entry.ring[0]!;
      const excess = entry.ringBytes - this.ringLimit;
      if (first.length <= excess) entry.ringBytes -= entry.ring.shift()!.length;
      else {
        // Copy the retained tail so an oversized PTY callback is not kept alive.
        entry.ring[0] = Buffer.from(first.subarray(excess));
        entry.ringBytes -= excess;
      }
    }
    entry.lastOutput = Date.now();
    if (entry.vt) {
      entry.vt.write(chunk);
      // A browser answers queries such as a cursor report only while m57 types. Otherwise nobody would, and some programs hang.
      const replies = entry.vt.responses();
      if (replies && entry.info.controller === "agent") entry.proc?.write(replies);
    }
    for (const l of entry.listeners) l.data(chunk);
    this.wake(entry);
  }

  private wake(entry: Entry) { for (const w of [...entry.watchers]) w(); }

  private end(entry: Entry, exitCode: number | null, reason?: string) {
    if (entry.info.status === "ended") return;
    entry.info.status = "ended";
    entry.info.exitCode = exitCode;
    if (reason) entry.info.endReason = reason;
    entry.proc = undefined;
    for (const l of entry.listeners) l.exit({ ...entry.info });
    this.wake(entry);
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

  /** Every terminal of every session. */
  all(): TerminalInfo[] { return [...this.entries.values()].map(e => ({ ...e.info })); }
  list(session: number): TerminalInfo[] {
    return [...this.entries.values()].filter(e => e.info.session === session).map(e => ({ ...e.info }));
  }

  /** Register a listener and return the buffered output. Both happen in one tick, so no byte is lost or sent twice. */
  attach(id: string, listener: TerminalListener): { info: TerminalInfo; replay: Buffer; detach(): void } {
    const e = this.entry(id);
    e.listeners.add(listener);
    return { info: { ...e.info }, replay: Buffer.concat(e.ring), detach: () => { e.listeners.delete(listener); } };
  }

  /** m57's keys. They are dropped while Luna has control, so input never collides. */
  write(id: string, data: string | Buffer) {
    const e = this.entry(id);
    if (e.info.controller === "user" && e.proc && e.info.status === "running") e.proc.write(data);
  }

  /** Only the side in control sets the size, so a browser tab cannot reflow the screen Luna is reading. */
  resize(id: string, cols: number, rows: number) {
    const e = this.entry(id);
    if (e.info.controller === "user") this.setSize(e, cols, rows);
  }

  private setSize(e: Entry, cols: number, rows: number) {
    if (!e.proc || e.info.status !== "running") return;
    const c = clamp(cols, 2, 500, e.info.cols), r = clamp(rows, 1, 300, e.info.rows);
    e.proc.resize(c, r);
    e.vt?.resize(c, r);
    e.info.cols = c; e.info.rows = r;
  }

  /** Luna's keys. Refused while m57 has control. */
  agentWrite(id: string, session: number, data: string) {
    const e = this.agentControlled(id, session);
    e.proc?.write(data);
  }

  agentResize(id: string, session: number, cols: number, rows: number) { this.setSize(this.agentControlled(id, session), cols, rows); }

  private agentControlled(id: string, session: number): Entry {
    const e = this.agentEntry(id, session);
    if (e.info.status !== "running") throw new TerminalError(`The terminal has ended${e.info.exitCode === null ? "" : ` with exit code ${e.info.exitCode}`}.`, 409);
    if (e.info.controller !== "agent") throw new TerminalError("m57 has control of this terminal. Wait until he gives it back, or ask him.", 409);
    return e;
  }

  /** m57's control actions. Sharing feeds the retained output to a new screen parser, so Luna sees the current screen. */
  async control(id: string, action: ControlAction): Promise<TerminalInfo> {
    const e = this.entry(id);
    if (action === "share" || action === "unshare") {
      if (e.info.owner === "agent") throw new TerminalError("Luna's own terminals are always visible to her.", 400);
      if (action === "share" && !e.info.shared) {
        if (!e.vt) {
          const vt = await (await this.factory())(e.info.cols, e.info.rows);
          if (this.entries.get(id) !== e) { vt.dispose(); throw new TerminalError("No such terminal.", 404); }
          vt.write(Buffer.concat(e.ring));
          vt.responses(); // old queries were answered long ago
          e.vt = vt;
        }
        e.info.shared = true;
      } else if (action === "unshare") {
        e.info.shared = false;
        e.info.controller = "user";
        e.vt?.dispose(); e.vt = undefined;
      }
    } else {
      if (action === "give" && !e.info.shared) throw new TerminalError("Share the terminal with Luna first.", 409);
      e.info.controller = action === "take" ? "user" : "agent";
    }
    const info = { ...e.info };
    for (const l of e.listeners) l.control?.(info);
    this.wake(e);
    return info;
  }

  /** Terminals Luna may see in a session: her own and the ones m57 shared. */
  agentList(session: number): TerminalInfo[] { return this.list(session).filter(t => t.shared); }

  /** The screen of a terminal Luna may see. `scrollback` adds that many earlier lines. */
  agentScreen(id: string, session: number, scrollback = 0): { info: TerminalInfo; screen: VtScreen; scrollback: string[]; idleMs: number } {
    const e = this.agentEntry(id, session);
    if (!e.vt) throw new TerminalError("The screen of this terminal is unavailable.", 503);
    return { info: { ...e.info }, screen: e.vt.screen(), scrollback: scrollback > 0 ? e.vt.scrollback(scrollback) : [], idleMs: Date.now() - e.lastOutput };
  }

  /** DEC private mode of a terminal Luna may see, e.g. 1 for application cursor keys. */
  agentMode(id: string, session: number, mode: number): boolean { return this.agentEntry(id, session).vt?.mode(mode) ?? false; }

  private agentEntry(id: string, session: number): Entry {
    const e = this.entries.get(id);
    if (!e || e.info.session !== session || !e.info.shared) throw new TerminalError("No such terminal in this session. Terminals end when the daemon restarts.", 404);
    return e;
  }

  /** Resolve when the terminal prints, ends, closes, or changes control, or after `ms`. */
  changed(id: string, ms: number, signal?: AbortSignal): Promise<void> {
    const e = this.entries.get(id);
    if (!e || signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); e.watchers.delete(done); signal?.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, Math.max(0, ms));
      e.watchers.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
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
    this.wake(e);
    e.vt?.dispose(); e.vt = undefined;
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
