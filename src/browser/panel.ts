// The browser panel's server side: which tabs a session owns, who drives each one, and a WebSocket that streams the page.
//
// Wire protocol (WebSocket /v1/browser/:tab/attach?ticket=...):
//   binary frames, server → client : one image (JPEG from CDP screencast, PNG from screenshot polling)
//   text frames,   server → client : {"type":"meta",width,height,url,controller,input,live} | {"type":"closed"} | {"type":"error",message}
//   text frames,   client → server : {"type":"input",event:BrowserInput}
// The server drops input while Luna drives. m57 takes the tab with the control route; Luna's tools then refuse that tab.
// The browser never puts the Bearer token in a URL: it asks for a ticket over authenticated HTTP, then opens the socket with the ticket.
import type { Server, ServerWebSocket } from "bun";
import type { BrowserFrame, BrowserInput, BrowserProvider, BrowserResolver, BrowserTab, BrowserTabHooks } from "../browser-tools.js";
import { validateWebUrl } from "../web-tools.js";

export class BrowserPanelError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 503 = 400) { super(message); }
}

export type Controller = "user" | "agent";
export interface PanelTab {
  tabId: string; session: number; worker: number | null; url: string;
  /** Who drives. The other side watches. */
  controller: Controller;
  /** Who opened the tab. */
  owner: Controller;
  /** m57 can click and type. False: view only. */
  input: boolean;
  /** Pushed frames. False: screenshots about once a second. */
  live: boolean;
}
interface Entry extends PanelTab { provider: BrowserProvider }

const TICKET_TTL_MS = 30_000;
const TICKETS_PER_MINUTE = 60;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_FRAME = 4096;
const POLL_MS = 1000;
const MAX_NOTICES = 20;
const ATTACH_PATH = /^\/v1\/browser\/([A-Za-z0-9_-]+)\/attach$/;
export const LOCK_MESSAGE = "m57 is using this tab. Nothing ran. Wait, or ask him to give it back.";

export type OriginPolicy = (origin: string, requestHost: string | undefined) => boolean;
export interface BrowserPanelOptions {
  /** Reads the live `browser.panel` setting. */
  enabled: () => boolean;
  resolve: BrowserResolver;
  allowOrigin?: OriginPolicy;
  now?: () => number;
  pollMs?: number;
}

/** Width and height of a PNG, read from its IHDR chunk. */
export function pngSize(data: Buffer): { width: number; height: number } {
  return data.length >= 24 && data.readUInt32BE(0) === 0x89504e47 ? { width: data.readUInt32BE(16), height: data.readUInt32BE(20) } : { width: 0, height: 0 };
}

export type BrowserWsData = { kind: "browser"; id: string };

interface Stream {
  sockets: Set<ServerWebSocket<BrowserWsData>>;
  abort: AbortController;
  last?: BrowserFrame;
}

export class BrowserPanel implements BrowserTabHooks {
  private tabs = new Map<string, Entry>();
  private streams = new Map<string, Stream>();
  private tickets = new Map<string, { tab: string; expires: number }>();
  private issued: number[] = [];
  /** m57's panel activity per session, until Luna's next browser call. */
  private notices = new Map<number, string[]>();
  private readonly now: () => number;

  constructor(private options: BrowserPanelOptions) { this.now = options.now ?? Date.now; }

  enabled() { return this.options.enabled(); }
  setOriginPolicy(policy: OriginPolicy) { this.options.allowOrigin = policy; }

  // --- tab registry (BrowserTabHooks) ---
  opened(tab: { session: number; worker: number | null; tabId: string; url: string; provider: BrowserProvider }, owner: Controller = "agent") {
    this.tabs.set(tab.tabId, {
      tabId: tab.tabId, session: tab.session, worker: tab.worker, url: tab.url, controller: "agent", owner,
      input: typeof tab.provider.input === "function", live: typeof tab.provider.watch === "function", provider: tab.provider,
    });
  }
  navigated(tab: BrowserTab) { const e = this.tabs.get(tab.tabId); if (e) { e.url = tab.url; this.pushMeta(e); } }
  closed(tabId: string) {
    this.tabs.delete(tabId);
    const stream = this.streams.get(tabId);
    if (stream) { for (const ws of stream.sockets) { this.json(ws, { type: "closed" }); ws.close(1000, "tab closed"); } stream.abort.abort(); this.streams.delete(tabId); }
  }
  assertAgent(tabId: string) { if (this.tabs.get(tabId)?.controller === "user") throw new Error(LOCK_MESSAGE); }
  /** Drop every tab of a deleted session and close its pages. */
  closeSession(session: number) {
    this.notices.delete(session);
    for (const e of [...this.tabs.values()].filter(t => t.session === session)) {
      void e.provider.close({ tabId: e.tabId }, new AbortController().signal).catch(() => {});
      this.closed(e.tabId);
    }
  }

  drain(session: number): string[] { const n = this.notices.get(session) ?? []; this.notices.delete(session); return n; }
  private note(session: number, text: string) {
    const n = this.notices.get(session) ?? [];
    n.push(text);
    if (n.length > MAX_NOTICES) n.splice(0, n.length - MAX_NOTICES);
    this.notices.set(session, n);
  }

  list(session: number): PanelTab[] {
    this.prune(session);
    return [...this.tabs.values()].filter(t => t.session === session).map(({ provider: _p, ...tab }) => tab);
  }
  /** Forget tabs the provider no longer has, e.g. after the browser restarted. Luna hears about it on her next browser call. */
  private prune(session: number) {
    for (const e of [...this.tabs.values()]) {
      if (e.session !== session || e.provider.has?.(e.tabId) !== false) continue;
      this.closed(e.tabId);
      this.note(session, `${e.tabId} is gone (the page closed or the browser restarted)`);
    }
  }
  all(): PanelTab[] { return [...this.tabs.values()].map(({ provider: _p, ...tab }) => tab); }
  get(tabId: string): PanelTab | undefined { const e = this.tabs.get(tabId); if (!e) return undefined; const { provider: _p, ...tab } = e; return tab; }
  private owned(session: number, tabId: string): Entry {
    const e = this.tabs.get(tabId);
    if (!e || e.session !== session) throw new BrowserPanelError("No such tab.", 404);
    return e;
  }

  // --- actions from the panel ---
  async open(session: number, worker: number | null, url: string, signal: AbortSignal): Promise<PanelTab> {
    try { validateWebUrl(url); } catch (e) { throw new BrowserPanelError((e as Error).message, 400); }
    const provider = await this.resolveOrThrow(worker, signal);
    const tab = await provider.open({ url }, signal);
    this.opened({ session, worker, ...tab, provider }, "user");
    const e = this.tabs.get(tab.tabId)!;
    e.controller = "user"; // m57 opened it from the panel, so he holds it
    this.note(session, `m57 opened ${tab.tabId} at ${tab.url}`);
    return this.get(tab.tabId)!;
  }
  private async resolveOrThrow(worker: number | null, signal: AbortSignal) {
    try { return await this.options.resolve(worker, signal); } catch (e) { throw new BrowserPanelError((e as Error).message, 503); }
  }
  async close(session: number, tabId: string) {
    const e = this.owned(session, tabId);
    await e.provider.close({ tabId }, new AbortController().signal).catch(() => {});
    this.closed(tabId);
    this.note(session, `m57 closed ${tabId}`);
  }
  control(session: number, tabId: string, action: "take" | "give"): PanelTab {
    const e = this.owned(session, tabId);
    if (action === "take" && !e.input) throw new BrowserPanelError("View only on this browser. Luna keeps the tab.", 409);
    if ((action === "take") !== (e.controller === "user")) this.note(session, action === "take" ? `m57 took over ${tabId}` : `m57 gave ${tabId} back to you`);
    e.controller = action === "take" ? "user" : "agent";
    this.pushMeta(e);
    return this.get(tabId)!;
  }

  // --- tickets ---
  issueTicket(session: number, tabId: string): { ticket: string; expiresIn: number } {
    this.owned(session, tabId);
    const now = this.now();
    this.issued = this.issued.filter(t => now - t < 60_000);
    if (this.issued.length >= TICKETS_PER_MINUTE) throw new BrowserPanelError("Too many browser connections. Wait a moment.", 409);
    this.issued.push(now);
    for (const [k, v] of this.tickets) if (v.expires <= now) this.tickets.delete(k);
    const ticket = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
    this.tickets.set(ticket, { tab: tabId, expires: now + TICKET_TTL_MS });
    return { ticket, expiresIn: TICKET_TTL_MS };
  }
  private redeem(ticket: string | null, tab: string): boolean {
    if (!ticket) return false;
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return !!entry && entry.tab === tab && entry.expires > this.now();
  }

  // --- WebSocket ---
  tryUpgrade(req: Request, server: Server<BrowserWsData>): Response | null | undefined {
    const url = new URL(req.url);
    const m = ATTACH_PATH.exec(url.pathname);
    if (!m) return undefined;
    const origin = req.headers.get("origin");
    if (origin && this.options.allowOrigin && !this.options.allowOrigin(origin, req.headers.get("host") ?? undefined)) return new Response(null, { status: 403 });
    const id = m[1]!;
    // The ticket is spent even when the tab is gone, so a leaked URL cannot be retried.
    if (!this.redeem(url.searchParams.get("ticket"), id)) return new Response(null, { status: 401 });
    if (!this.tabs.has(id)) return new Response(null, { status: 404 });
    if (!this.enabled()) return new Response(null, { status: 403 });
    if (server.upgrade(req, { data: { kind: "browser", id } satisfies BrowserWsData })) return null;
    return new Response("WebSocket upgrade failed", { status: 400 });
  }

  private json(ws: ServerWebSocket<BrowserWsData>, value: unknown) { if (ws.readyState === 1) ws.sendText(JSON.stringify(value)); }
  private meta(e: Entry, frame?: BrowserFrame) {
    return { type: "meta", width: frame?.width ?? this.streams.get(e.tabId)?.last?.width ?? 0, height: frame?.height ?? this.streams.get(e.tabId)?.last?.height ?? 0, url: e.url, controller: e.controller, input: e.input, live: e.live };
  }
  private pushMeta(e: Entry) {
    const stream = this.streams.get(e.tabId);
    if (stream) for (const ws of stream.sockets) this.json(ws, this.meta(e));
  }

  wsOpen(ws: ServerWebSocket<BrowserWsData>) {
    const id = ws.data.id;
    const entry = this.tabs.get(id);
    if (!entry) { ws.close(1011, "tab closed"); return; }
    let stream = this.streams.get(id);
    if (!stream) { stream = { sockets: new Set(), abort: new AbortController() }; this.streams.set(id, stream); this.startFeed(entry, stream); }
    stream.sockets.add(ws);
    this.json(ws, this.meta(entry));
    if (stream.last && ws.readyState === 1) ws.sendBinary(stream.last.data);
  }

  wsMessage(ws: ServerWebSocket<BrowserWsData>, raw: string | Buffer) {
    if (typeof raw !== "string") return;
    if (Buffer.byteLength(raw) > MAX_INPUT_FRAME) { ws.close(1009, "frame too large"); return; }
    const id = ws.data.id;
    const e = this.tabs.get(id);
    if (!e) return;
    let msg: { type?: unknown; event?: unknown };
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== "input") return;
    if (e.controller !== "user") return; // Luna drives: the view is read-only
    if (!e.provider.input) { this.json(ws, { type: "error", message: "View only on this browser." }); return; }
    const event = parseInput(msg.event);
    if (!event) return;
    e.provider.input({ tabId: id, event }).then(result => {
      if (result?.url && result.url !== e.url) { e.url = result.url; this.pushMeta(e); this.note(e.session, `m57 went to ${result.url} in ${id}`); }
    }).catch(error => this.json(ws, { type: "error", message: (error as Error).message }));
  }

  wsClose(ws: ServerWebSocket<BrowserWsData>) {
    const id = ws.data.id;
    const s = this.streams.get(id);
    if (!s) return;
    s.sockets.delete(ws);
    if (!s.sockets.size) { s.abort.abort(); this.streams.delete(id); }
  }

  /** One feed per tab, shared by every socket. CDP push when the provider has it, screenshots otherwise. */
  private startFeed(entry: Entry, stream: Stream) {
    const signal = stream.abort.signal;
    const emit = (frame: BrowserFrame) => {
      stream.last = frame;
      if (frame.url && frame.url !== entry.url) entry.url = frame.url;
      const meta = JSON.stringify(this.meta(entry, frame));
      for (const ws of stream.sockets) {
        if (ws.readyState !== 1) continue;
        if (ws.getBufferedAmount() > MAX_BUFFERED_BYTES) continue; // a slow client skips frames; nothing is lost
        ws.sendText(meta);
        ws.sendBinary(frame.data);
      }
    };
    const poll = async () => {
      while (!signal.aborted) {
        try {
          const image = await entry.provider.screenshot({ tabId: entry.tabId }, signal);
          const data = Buffer.from(image.data, "base64");
          emit({ data, ...pngSize(data) });
        } catch (error) {
          if (signal.aborted) return;
          this.dropDead(entry, error as Error);
          return;
        }
        await new Promise<void>(r => { const t = setTimeout(r, this.options.pollMs ?? POLL_MS); signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
      }
    };
    const watch = entry.provider.watch;
    if (!watch) { void poll(); return; }
    // A watch that ends while sockets remain means the page is gone, or the engine has no screencast: fall back to polling.
    watch.call(entry.provider, { tabId: entry.tabId, maxWidth: 1280, maxHeight: 800 }, emit, signal)
      .then(() => { if (!signal.aborted) void poll(); })
      .catch(() => { if (!signal.aborted) { entry.live = false; this.pushMeta(entry); void poll(); } });
  }

  /** The page behind a tab is gone. Tell the sockets and forget it. */
  private dropDead(entry: Entry, error: Error) {
    if (/No open tab|closed|not found/i.test(error.message)) this.closed(entry.tabId);
    else for (const ws of this.streams.get(entry.tabId)?.sockets ?? []) this.json(ws, { type: "error", message: error.message });
  }

  closeAll() {
    for (const s of this.streams.values()) {
      s.abort.abort();
      for (const ws of s.sockets) ws.close(1001, "daemon stopping");
      s.sockets.clear();
    }
    this.streams.clear();
  }
}

/** Accept only the events the panel sends; coordinates must be finite numbers. */
export function parseInput(raw: unknown): BrowserInput | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const e = raw as Record<string, unknown>;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : undefined;
  if (e.kind === "mouse") {
    const x = num(e.x), y = num(e.y);
    if (x === undefined || y === undefined || !["move", "down", "up"].includes(e.type as string)) return undefined;
    const button = ["left", "middle", "right"].includes(e.button as string) ? e.button as "left" | "middle" | "right" : undefined;
    const clickCount = num(e.clickCount);
    return { kind: "mouse", type: e.type as "move" | "down" | "up", x, y, ...(button ? { button } : {}), ...(clickCount !== undefined ? { clickCount: Math.min(3, Math.max(1, Math.trunc(clickCount))) } : {}) };
  }
  if (e.kind === "wheel") {
    const x = num(e.x), y = num(e.y), deltaX = num(e.deltaX), deltaY = num(e.deltaY);
    return x === undefined || y === undefined || deltaX === undefined || deltaY === undefined ? undefined : { kind: "wheel", x, y, deltaX, deltaY };
  }
  if (e.kind === "key") {
    if ((e.type !== "down" && e.type !== "up") || typeof e.key !== "string" || !e.key || e.key.length > 32) return undefined;
    return { kind: "key", type: e.type, key: e.key };
  }
  if (e.kind === "nav") {
    if (!["goto", "back", "forward", "reload"].includes(e.action as string)) return undefined;
    if (e.action === "goto") { if (typeof e.url !== "string") return undefined; try { validateWebUrl(e.url); } catch { return undefined; } return { kind: "nav", action: "goto", url: e.url }; }
    return { kind: "nav", action: e.action as "back" | "forward" | "reload" };
  }
  return undefined;
}
