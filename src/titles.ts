// Automatic session titles: one cheap auxiliary-model call after a session's first finished answer.
// - Runs only with a configured route (auxiliary.session_title, else auxiliary.side_question). Never the session model.
// - Thinking is always off, whatever the session's thinking level. Input and output are small and bounded.
// - A user title always wins: the write is conditional, so a rename during the call is kept.
import type { Models, Usage } from "@earendil-works/pi-ai";
import { UsageDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import type { ConversationStore } from "./conversations.js";
import { context } from "./luna.js";

type Harness = Awaited<ReturnType<typeof import("./luna.js").openLuna>>;
export type TitleRoute = { provider: string; modelId: string };

export const TITLE_INSTRUCTION = "Write a title for this conversation. Use 3 to 6 words. " +
  "Use the language of the user's message. Name the topic, not the request style. " +
  "No quotes, no emojis, no final punctuation. Reply with the title only.";
const USER_CHARS = 1200, ANSWER_CHARS = 800, MAX_OUTPUT_TOKENS = 40, MAX_TITLE = 80;

const textOf = (msgs: readonly unknown[] | undefined) => (msgs ?? []).map(m => {
  const c = (m as { content?: unknown }).content;
  if (typeof c === "string") return c;
  return Array.isArray(c) ? c.map((b: { type?: string; text?: string }) => b.type === "text" ? b.text ?? "" : "").join("") : "";
}).join("\n").trim();

/** One line, no wrapping quotes, label, or final punctuation. Empty when the model gave nothing usable. */
export function cleanTitle(raw: string): string {
  let t = raw.split("\n").map(s => s.trim()).find(Boolean) ?? "";
  t = t.replace(/^(title|العنوان)\s*[:：]\s*/i, "").replace(/^[*#\s]+|[*\s]+$/g, "");
  t = t.replace(/^["'“”‘’«»`]+|["'“”‘’«»`.。!؟?,،;:\s]+$/gu, "").replace(/\s+/g, " ").trim();
  return t.length > MAX_TITLE ? t.slice(0, MAX_TITLE - 1).trimEnd() + "…" : t;
}

/** First user message and the first assistant text answer. Undefined until both exist. */
export async function firstExchange(tx: Pick<Tx, "scanEntries">, id: ConversationId) {
  let user = "", cursor;
  do {
    const page = await tx.scanEntries({ conversationId: id, order: "ascending" }, 100, cursor);
    for (const e of page.items) {
      if (e.kind === "delegate.child") return undefined;
      if (e.kind === "pi.user" && !user) user = textOf(e.model);
      else if (e.kind === "pi.assistant" && user) {
        const answer = textOf((e.model ?? []).filter(m => (m as { role?: string }).role === "assistant"));
        if (answer) return { user, answer };
      }
    }
    cursor = page.next;
  } while (cursor);
  return undefined;
}

export class SessionTitler {
  private readonly attempted = new Set<number>();
  private readonly running = new Map<number, Promise<string | null>>();
  private stopCommits?: () => void;
  private closed = false;
  constructor(private readonly o: {
    harness: Harness; conversations: ConversationStore; models?: Models; route: () => TitleRoute | undefined;
  }) {}

  /** Title sessions after a top-level turn ends. */
  start() {
    this.stopCommits = this.o.harness.subscribeCommits(p => {
      for (const ch of p.changes) {
        if (ch.type !== "task" || ch.value.owner || ch.value.state.status !== "terminal") continue;
        const id = Number(ch.value.conversationId);
        if (this.attempted.has(id) || this.o.conversations.get(id).title !== null) continue;
        void this.generate(id, false).catch(() => {});
      }
    });
  }
  /** True when a route resolves to a known model with credentials. */
  available() { return !!this.model(); }
  private model() {
    const r = this.o.route(), models = this.o.models;
    return r && models ? models.getModel(r.provider, r.modelId) : undefined;
  }

  /**
   * Generate and store a title. Automatic runs (force=false) happen once per session per process and only while no
   * title exists. A forced run is an explicit user request and replaces any title. Returns the stored title or null.
   */
  generate(id: number, force: boolean): Promise<string | null> {
    const prior = this.running.get(id);
    if (prior) return prior;
    if (!force) this.attempted.add(id);
    const run = this.run(id, force).finally(() => this.running.delete(id));
    this.running.set(id, run);
    return run;
  }

  private async run(id: number, force: boolean): Promise<string | null> {
    if (this.closed) return null;
    const model = this.model();
    if (!model || !this.o.models || !await this.o.models.getAuth(model)) { if (force) throw new Error("No session-title model is configured."); return null; }
    const exchange = await this.o.harness.commit(async tx => {
      const c = await tx.conversation(id as never);
      if (!c) throw new Error("no such session");
      if (!force && (c.parent || c.owner)) return undefined; // forks and owned children keep their own naming
      return firstExchange(tx, id as never);
    }, context);
    if (!exchange) { if (force) throw new Error("The session needs a finished answer before it can get a title."); return null; }
    const response = await this.o.models.completeSimple(model, {
      systemPrompt: TITLE_INSTRUCTION, tools: [],
      messages: [{ role: "user", timestamp: Date.now(),
        content: `USER: ${exchange.user.slice(0, USER_CHARS)}\n\nASSISTANT: ${exchange.answer.slice(0, ANSWER_CHARS)}` }],
    }, { maxTokens: MAX_OUTPUT_TOKENS }); // no `reasoning`: thinking stays off
    await this.usage(id, `${model.provider}/${model.id}`, response.usage).catch(() => {});
    if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage || response.stopReason);
    const title = cleanTitle(response.content.filter(b => b.type === "text").map(b => b.text).join("\n"));
    if (!title || this.closed) { if (force) throw new Error("The title model returned no title."); return null; }
    return await this.o.conversations.autoTitle(id, title, force) ? title : null;
  }

  private usage(id: number, key: string, usage: Usage) {
    return this.o.harness.commit(async tx => {
      const totals = (await tx.doc(UsageDoc, id as never)).models;
      const total = Object.hasOwn(totals, key) ? totals[key] : undefined;
      if (!total) { totals[key] = JSON.parse(JSON.stringify(usage)); return; }
      for (const f of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[f] += usage[f];
      for (const f of ["cacheWrite1h", "reasoning"] as const) if (usage[f] !== undefined) total[f] = (total[f] ?? 0) + usage[f]!;
      for (const f of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[f] += usage.cost[f];
    }, context);
  }

  async close() {
    this.closed = true; this.stopCommits?.();
    await Promise.allSettled([...this.running.values()]);
  }
}
