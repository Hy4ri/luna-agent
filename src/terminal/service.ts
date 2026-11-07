// Network face of the terminal registry: single-use attach tickets and the WebSocket endpoint.
//
// Wire protocol on /v1/terminals/:id/attach
//   binary frames, both ways : raw terminal bytes (input from the client, output from the shell)
//   text frames, client → server : {"type":"resize","cols":n,"rows":n}
//   text frames, server → client : {"type":"replay-start",cols,rows,controller,shared} | {"type":"replay-end"}
//                                  | {"type":"control","controller":"user"|"agent","shared":b} | {"type":"exit","exitCode":n|null,"reason"?:s} | {"type":"closed"}
// While Luna has control the server drops the client's keys and resizes, so the client shows the terminal read-only.
// The browser never puts the Bearer token in a URL: it asks for a ticket over authenticated HTTP, then opens the socket with the ticket.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { TerminalError, type TerminalInfo, type TerminalRegistry } from "./registry.js";

const ATTACH_PATH = /^\/v1\/terminals\/([0-9a-f-]{36})\/attach$/;
export const TICKET_TTL_MS = 30_000;
const TICKETS_PER_MINUTE = 60;
/** A stalled client must not make the daemon buffer output without limit. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_FRAME = 1024 * 1024;

export type OriginPolicy = (origin: string, host: string | undefined) => boolean;

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
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT_FRAME });
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
    const ticket = randomBytes(24).toString("base64url");
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
  attach(server: Pick<Server, "on">) { server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head)); }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? "/", "http://x");
    const m = ATTACH_PATH.exec(url.pathname);
    if (!m) return;
    const reject = (code: number, text: string) => socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    const origin = req.headers.origin;
    if (origin && this.options.allowOrigin && !this.options.allowOrigin(origin, req.headers.host)) return reject(403, "Forbidden");
    const id = m[1]!;
    // The ticket is spent even when the terminal is gone, so a leaked URL cannot be retried.
    if (!this.redeem(url.searchParams.get("ticket"), id)) return reject(401, "Unauthorized");
    const info = this.registry.get(id);
    if (!info) return reject(404, "Not Found");
    if (!this.viewable(info)) return reject(403, "Forbidden");
    this.wss.handleUpgrade(req, socket, head, ws => this.serve(id, ws));
  }

  private serve(id: string, ws: WebSocket) {
    const json = (value: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
    const exitMessage = (info: TerminalInfo) => json({ type: "exit", exitCode: info.exitCode, ...(info.endReason ? { reason: info.endReason } : {}) });
    let live = false;
    const queued: Buffer[] = [];
    const send = (chunk: Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) { ws.close(1013, "client too slow"); return; }
      ws.send(chunk, { binary: true });
    };
    // attach() registers the listener and snapshots the ring in the same tick, so nothing is missed or sent twice.
    const attached = this.registry.attach(id, {
      data: chunk => { if (live) send(chunk); else queued.push(chunk); },
      exit: exitMessage,
      closed: () => { json({ type: "closed" }); ws.close(1000, "terminal closed"); },
      control: info => json({ type: "control", controller: info.controller, shared: info.shared }),
    });
    json({ type: "replay-start", cols: attached.info.cols, rows: attached.info.rows, controller: attached.info.controller, shared: attached.info.shared });
    if (attached.replay.length) send(attached.replay);
    json({ type: "replay-end" });
    live = true;
    for (const chunk of queued.splice(0)) send(chunk);
    if (attached.info.status === "ended") exitMessage(attached.info);

    ws.on("message", (raw, isBinary) => {
      try {
        if (isBinary) {
          this.registry.write(id, Buffer.isBuffer(raw) ? raw : Buffer.concat(raw as Buffer[]));
          return;
        }
        const msg = JSON.parse(String(raw)) as { type?: unknown; cols?: unknown; rows?: unknown };
        if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") this.registry.resize(id, msg.cols, msg.rows);
      } catch (e) {
        if (e instanceof TerminalError) ws.close(1011, e.message); // terminal vanished
        // malformed JSON from a client is ignored
      }
    });
    ws.on("error", () => { /* the close handler cleans up */ });
    ws.on("close", () => attached.detach());
  }

  /** Close every terminal and socket. The daemon calls this on shutdown. */
  close() {
    this.registry.closeAll();
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }
}
