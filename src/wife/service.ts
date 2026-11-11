// Runs the detectors, files their cards, and carries out an agreed card.
import type { AnalyticsStore } from "../analytics/store.js";
import type { ConversationStore } from "../conversations.js";
import { staleSessions, type DetectorConfig } from "./detectors.js";
import type { Suggestion, WifeStore } from "./store.js";

export class WifeError extends Error { constructor(readonly status: 400 | 404 | 409, message: string) { super(message); } }

export interface WifeServiceOptions {
  store: WifeStore; analytics: () => AnalyticsStore; conversations: ConversationStore;
  config: () => DetectorConfig & { enabled: boolean; detectEveryMinutes: number }; now?: () => number; log?: (m: string) => void;
}

export class WifeService {
  private timer?: ReturnType<typeof setInterval>;
  constructor(private o: WifeServiceOptions) {}
  get store() { return this.o.store; }

  /** Run every detector once. File new cards, refresh open ones, and withdraw open cards that no longer apply. */
  scan(): { filed: number; withdrawn: number } {
    const now = (this.o.now ?? Date.now)();
    this.o.store.expireSnoozed(now);
    const sessions = this.o.analytics().sessions();
    const found = staleSessions(sessions, this.o.config(), now);
    let filed = 0;
    for (const f of found) {
      const isNew = !this.o.store.has(f.fingerprint);
      this.o.store.file(f);
      if (isNew) filed++;
    }
    let withdrawn = 0;
    for (const kind of ["archive_session", "delete_session"] as const)
      withdrawn += this.o.store.withdrawOpen(kind, new Set(found.filter(f => f.kind === kind).map(f => f.fingerprint)));
    return { filed, withdrawn };
  }

  start() {
    const run = () => { try { if (this.o.config().enabled) this.scan(); } catch (e) { this.o.log?.(`wife: scan failed: ${(e as Error).message}`); } };
    run();
    this.timer = setInterval(run, Math.max(1, this.o.config().detectEveryMinutes) * 60_000);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  /** Carry out an open card. The target is checked again first. A failure is recorded on the card and thrown. */
  async agree(id: number, opts: { confirm?: boolean } = {}): Promise<Suggestion> {
    const card = this.o.store.get(id);
    if (!card) throw new WifeError(404, "no such suggestion");
    if (card.status !== "open" && card.status !== "snoozed") throw new WifeError(409, `suggestion is ${card.status}`);
    try {
      let result: string;
      const sid = Number(card.payload.sessionId);
      if (card.kind === "archive_session") {
        const meta = this.o.conversations.get(sid);
        if (meta.pinned) throw new WifeError(409, "session is pinned now");
        await this.o.conversations.update(sid, { archived: true });
        result = "Archived.";
      } else if (card.kind === "delete_session") {
        if (opts.confirm !== true) throw new WifeError(400, "deleting needs confirm:true");
        if (!this.o.conversations.get(sid).archived) throw new WifeError(409, "session is no longer archived");
        if (this.o.conversations.get(sid).pinned) throw new WifeError(409, "session is pinned now");
        await this.o.conversations.delete(sid);
        result = "Deleted.";
      } else throw new WifeError(400, `${card.kind} cards cannot be agreed yet`);
      this.o.store.setStatus(id, "done", { result });
      this.o.store.record(card, "agree");
    } catch (e) {
      if (e instanceof WifeError) throw e;  // a refused precondition leaves the card open
      this.o.store.setStatus(id, "failed", { result: (e as Error).message });
      this.o.store.record(card, "failed", null, (e as Error).message);
      throw e;
    }
    return this.o.store.get(id)!;
  }
}
