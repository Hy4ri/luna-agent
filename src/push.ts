// Android push through Firebase Cloud Messaging (HTTP v1). No SDK: a service-account JWT and fetch.
import { createSign } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { delegateParent } from "./delegate-parent.js";
import { context } from "./luna.js";
import { isRunning, readSessionStatus, type SessionStatus } from "./session-status.js";

type Harness = Awaited<ReturnType<typeof import("./luna.js").openLuna>>;
type Fetch = typeof fetch;

export interface ServiceAccount { project_id: string; client_email: string; private_key: string; token_uri?: string }

export function loadServiceAccount(file: string): ServiceAccount {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ServiceAccount>;
  if (!raw.project_id || !raw.client_email || !raw.private_key) throw new Error(`push: ${file} is not a service-account key`);
  return { project_id: raw.project_id, client_email: raw.client_email, private_key: raw.private_key, token_uri: raw.token_uri };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Registered phones. A small JSON file: a handful of tokens, rewritten atomically. */
export class DeviceStore {
  private tokens: string[];
  constructor(private readonly file: string) {
    try { this.tokens = (JSON.parse(readFileSync(file, "utf8")) as { tokens?: string[] }).tokens ?? []; } catch { this.tokens = []; }
  }
  list() { return [...this.tokens]; }
  add(token: string) { if (!this.tokens.includes(token)) { this.tokens.push(token); this.save(); } }
  remove(token: string) { if (this.tokens.includes(token)) { this.tokens = this.tokens.filter(t => t !== token); this.save(); } }
  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ tokens: this.tokens }), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

export interface PushMessage { title: string; body: string; sessionId: string; status: string }

export class FcmSender {
  private access?: { token: string; expires: number };
  constructor(private readonly account: ServiceAccount, private readonly devices: DeviceStore, private readonly fetchImpl: Fetch = fetch) {}

  private async accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.access && this.access.expires - 60 > now) return this.access.token;
    const uri = this.account.token_uri ?? "https://oauth2.googleapis.com/token";
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(JSON.stringify({ iss: this.account.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: uri, iat: now, exp: now + 3600 }));
    const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(this.account.private_key).toString("base64url");
    const r = await this.fetchImpl(uri, {
      method: "POST", signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${sig}` }),
    });
    if (!r.ok) throw new Error(`FCM auth HTTP ${r.status}`);
    const j = await r.json() as { access_token: string; expires_in: number };
    this.access = { token: j.access_token, expires: now + j.expires_in };
    return j.access_token;
  }

  /** Send to every registered phone. A token FCM no longer knows is dropped. */
  async send(m: PushMessage): Promise<void> {
    const tokens = this.devices.list();
    if (!tokens.length) return;
    const bearer = await this.accessToken();
    const url = `https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`;
    await Promise.all(tokens.map(async token => {
      const r = await this.fetchImpl(url, {
        method: "POST", signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: {
          token,
          notification: { title: m.title, body: m.body },
          data: { sessionId: m.sessionId, status: m.status },
          // One notification per session: a later status replaces the earlier one.
          android: { priority: "HIGH", notification: { tag: `session-${m.sessionId}` } },
        } }),
      });
      if (r.status === 404 || r.status === 400) {
        const text = await r.text().catch(() => "");
        if (/UNREGISTERED|INVALID_ARGUMENT/.test(text)) this.devices.remove(token);
      } else if (!r.ok) throw new Error(`FCM send HTTP ${r.status}`);
    }));
  }
}

const LABELS: Partial<Record<SessionStatus, string>> = {
  finished: "Finished", review_finished: "Review finished", needs_input: "Needs your input",
  needs_approval: "Needs your approval", failed: "Failed", limit_reached: "Limit reached",
};
const WAS_ACTIVE = new Set<SessionStatus>(["running", "reviewing"]);

/** Watches session commits and pushes when a running session stops or asks for the user. */
export class PushNotifier {
  private readonly last = new Map<number, SessionStatus>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private observation?: { detach(): void };
  private closed = false;

  constructor(private readonly o: {
    harness: Harness;
    send: (m: PushMessage) => Promise<void>;
    log?: (msg: string) => void;
    title: (id: number) => string | null;
    skip: (id: number) => boolean;
    /** Cron runs are unattended: only a failure is worth a push. */
    isCron: (id: number) => boolean;
    debounceMs?: number;
  }) {}

  start() {
    this.observation = this.o.harness.observeCommits({
      advance: p => {
        for (const ch of p.changes) {
          if (ch.type === "entry") continue; // streamed text never changes status
          const id = ch.type === "conversation" ? ch.value.id : ch.type === "task" || ch.type === "submission" ? ch.value.conversationId : ch.conversationId;
          if (id !== undefined) this.schedule(Number(id));
        }
      },
      end: () => { this.closed = true; },
    });
  }

  private schedule(id: number) {
    if (this.closed || this.timers.has(id)) return;
    this.timers.set(id, setTimeout(() => { this.timers.delete(id); void this.check(id).catch(e => this.o.log?.(`push: ${(e as Error).message}`)); }, this.o.debounceMs ?? 1500));
  }

  private async check(id: number) {
    if (this.closed) return;
    const read = await this.o.harness.commit(async (tx: Tx) => {
      if (await delegateParent(tx, id as unknown as ConversationId)) return undefined; // subagents report through their parent
      const running = await isRunning(tx, id as unknown as ConversationId);
      return readSessionStatus(tx, id as unknown as ConversationId, running);
    }, context);
    if (!read) return;
    const was = this.last.get(id);
    this.last.set(id, read.status);
    if (!was || !WAS_ACTIVE.has(was) || !LABELS[read.status]) return;
    if (this.o.skip(id)) return;
    if (this.o.isCron(id) && read.status !== "failed") return;
    const label = LABELS[read.status]!;
    const reason = read.statusReason?.replace(/\s+/g, " ").trim();
    await this.o.send({
      title: this.o.title(id) || `Session #${id}`,
      body: reason && read.status !== "finished" ? `${label}: ${reason.slice(0, 140)}` : label,
      sessionId: String(id), status: read.status,
    });
  }

  async close() {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.observation?.detach();
  }
}
