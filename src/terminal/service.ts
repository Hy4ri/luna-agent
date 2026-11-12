// Network face of the terminal registry: single-use attach tickets and the WebSocket endpoint.
//
// Wire protocol on /v1/terminals/:id/attach
//   binary frames, both ways : raw terminal bytes (input from the client, output from the shell)
//   text frames, client → server : {"type":"resize","cols":n,"rows":n}
//   text frames, server → client : {"type":"replay-start",cols,rows,shared} | {"type":"replay-end"}
//                                  | {"type":"exit","exitCode":n|null,"reason"?:s} | {"type":"closed"}
// While Luna has control the server drops the client's keys and resizes, so the client shows the terminal read-only.
// The browser never puts the Bearer token in a URL: it asks for a ticket over authenticated HTTP, then opens the socket with the ticket.
import type { Server, ServerWebSocket } from "bun";
import { TerminalError, type TerminalInfo, type TerminalRegistry } from "./registry.js";

const ATTACH_PATH = /^\/v1\/terminals\/([0-9a-f-]{36})\/attach$/;
export const TICKET_TTL_MS = 30_000;
const TICKETS_PER_MINUTE = 60;
/** A stalled client must not make the daemon buffer output without limit. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_FRAME = 1024 * 1024;

export type OriginPolicy = (origin: string, host: string | undefined) => boolean;

export type TerminalWsData = { kind: "terminal"; id: string; detach?: () => void };

export interface TerminalServiceOptions {
  registry: TerminalRegistry;
  /** Reads the live `terminal.user` setting. */
  enabled: () => boolean;
  /** Reads the live `terminal.agent` setting. Luna's own terminals stay viewable with it alone. Default off. */
  agentEnabled?: () => boolean;
  /** Decide whether a browser Origin may open a terminal socket. Requests without an Origin (non-browser clients) are allowed. */
  allowOrigin?: OriginPolicy;
  now?: () => number;
}

export class TerminalService {
  readonly registry: TerminalRegistry;
  private tickets = new Map<string, { terminal: string; expires: number }>();
  private issued: number[] = [];
  private sockets = new Set<ServerWebSocket<TerminalWsData>>();
  private readonly now: () => number;

  constructor(private options: TerminalServiceOptions) {
    this.registry = options.registry;
    this.now = options.now ?? Date.now;
  }

  enabled() { return this.options.enabled(); }
  agentEnabled() { return this.options.agentEnabled?.() ?? false; }
  /** m57 may open and watch this terminal: any terminal with `terminal.user`, Luna's own with `terminal.agent`. */
  viewable(info: TerminalInfo | undefined) { return !!info && (this.enabled() || (info.owner === "agent" && this.agentEnabled())); }
  /** Replace the browser Origin policy. The daemon sets it once it knows which origins it serves. */
  setOriginPolicy(policy: OriginPolicy) { this.options.allowOrigin = policy; }

  /** A ticket for one WebSocket attach. It names the terminal, expires after 30 seconds and works once. */
  issueTicket(terminal: string): { ticket: string; expiresIn: number } {
    if (!this.registry.get(terminal)) throw new TerminalError("No such terminal.", 404);
    const now = this.now();
    this.issued = this.issued.filter(t => now - t < 60_000);
    if (this.issued.length >= TICKETS_PER_MINUTE) throw new TerminalError("Too many terminal connections. Wait a moment.", 409);
    this.issued.push(now);
    for (const [k, v] of this.tickets) if (v.expires <= now) this.tickets.delete(k);
    const ticket = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
    this.tickets.set(ticket, { terminal, expires: now + TICKET_TTL_MS });
    return { ticket, expiresIn: TICKET_TTL_MS };
  }

  private redeem(ticket: string | null, terminal: string): boolean {
    if (!ticket) return false;
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return !!entry && entry.terminal === terminal && entry.expires > this.now();
  }

  /** Handle terminal upgrades on the daemon's HTTP server. Other upgrades are left to their own handlers. */
  tryUpgrade(req: Request, server: Server<TerminalWsData>): Response | null | undefined {
    const url = new URL(req.url);
    const m = ATTACH_PATH.exec(url.pathname);
    if (!m) return undefined;
    const origin = req.headers.get("origin");
    if (origin && this.options.allowOrigin && !this.options.allowOrigin(origin, req.headers.get("host") ?? undefined)) return new Response(null, { status: 403 });
    const id = m[1]!;
    // The ticket is spent even when the terminal is gone, so a leaked URL cannot be retried.
    if (!this.redeem(url.searchParams.get("ticket"), id)) return new Response(null, { status: 401 });
    const info = this.registry.get(id);
    if (!info) return new Response(null, { status: 404 });
    if (!this.viewable(info)) return new Response(null, { status: 403 });
    if (server.upgrade(req, { data: { kind: "terminal", id } satisfies TerminalWsData })) return null;
    return new Response("WebSocket upgrade failed", { status: 400 });
  }

  wsOpen(ws: ServerWebSocket<TerminalWsData>) {
    const id = ws.data.id;
    this.sockets.add(ws);
    const json = (value: unknown) => { if (ws.readyState === 1) ws.sendText(JSON.stringify(value)); };
    const exitMessage = (info: TerminalInfo) => json({ type: "exit", exitCode: info.exitCode, ...(info.endReason ? { reason: info.endReason } : {}) });
    let live = false;
    const queued: Buffer[] = [];
    const send = (chunk: Buffer) => {
      if (ws.readyState !== 1) return;
      if (ws. getBufferedAmount() > MAX_BUFFERED_BYTES) { ws.close(1013, "client too slow"); return; }
      ws.sendBinary(chunk);
    };
    // attach() registers the listener and snapshots the ring in the same tick, so nothing is missed or sent twice.
    let attached: ReturnType<TerminalRegistry["attach"]>;
    try {
      attached = this.registry.attach(id, {
        data: chunk => { if (live) send(chunk); else queued.push(chunk); },
        exit: exitMessage,
        closed: () => { json({ type: "closed" }); ws.close(1000, "terminal closed"); },
      });
    } catch {
      ws.close(1011, "terminal vanished");
      return;
    }
    ws.data.detach = () => attached.detach();
    json({ type: "replay-start", cols: attached.info.cols, rows: attached.info.rows, shared: attached.info.shared });
    if (attached.replay.length) send(attached.replay);
    json({ type: "replay-end" });
    live = true;
    for (const chunk of queued.splice(0)) send(chunk);
    if (attached.info.status === "ended") exitMessage(attached.info);
  }

  wsMessage(ws: ServerWebSocket<TerminalWsData>, raw: string | Buffer) {
    const id = ws.data.id;
    try {
      if (typeof raw !== "string") {
        if (raw.byteLength > MAX_INPUT_FRAME) { ws.close(1009, "frame too large"); return; }
        this.registry.write(id, Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
        return;
      }
      if (Buffer.byteLength(raw) > MAX_INPUT_FRAME) { ws.close(1009, "frame too large"); return; }
      const msg = JSON.parse(raw) as { type?: unknown; cols?: unknown; rows?: unknown };
      if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") this.registry.resize(id, msg.cols, msg.rows);
    } catch (e) {
      if (e instanceof TerminalError) ws.close(1011, e.message); // terminal vanished
      // malformed JSON from a client is ignored
    }
  }

  wsClose(ws: ServerWebSocket<TerminalWsData>) {
    this.sockets.delete(ws);
    ws.data.detach?.();
    ws.data.detach = undefined;
  }

  /** Close every terminal and socket. The daemon calls this on shutdown. */
  close() {
    this.registry.closeAll();
    for (const ws of this.sockets) ws.close(1001, "daemon stopping");
    this.sockets.clear();
  }
}
