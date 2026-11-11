// The `wife` agent tool. The daily luna-wife cron job uses it to read what Wife already filed and to file model-found cards.
import { Type, type Static } from "typebox";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { StringEnum } from "../string-enum.js";
import type { WifeService } from "./service.js";
import type { NewSuggestion } from "./store.js";

const KINDS = ["skill", "memory", "feature_tip", "new_project"] as const;
const text = (t: string, isError = false) => ({ output: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

const Params = Type.Object({
  action: StringEnum(["list", "suggest"], { description: "list: cards Wife already has. suggest: file one new card." }),
  kind: Type.Optional(StringEnum(KINDS, { description: "suggest: card kind." })),
  title: Type.Optional(Type.String({ description: "suggest: short title." })),
  body: Type.Optional(Type.String({ description: "suggest: why, in one or two sentences." })),
  evidence: Type.Optional(Type.Array(Type.Object({ sessionId: Type.Number(), note: Type.String() }), { description: "suggest: sessions that show the pattern. Each must exist." })),
  payload: Type.Optional(Type.Object({}, { additionalProperties: true, description: "memory: {key?, content}. skill: {name, existing?, outline}. new_project: {name, cwd, worker, sessionIds}. feature_tip: {}." })),
});
type Args = Static<typeof Params>;

/** Check a model card at the boundary. Returns the card, or an error text. */
export function buildCard(a: Args, sessionExists: (id: number) => boolean): NewSuggestion | string {
  if (!a.kind || !a.title?.trim() || !a.body?.trim()) return "suggest needs kind, title and body";
  const evidence = a.evidence ?? [];
  if (!evidence.length) return "suggest needs at least one evidence session";
  for (const e of evidence) if (!Number.isSafeInteger(e.sessionId) || !sessionExists(e.sessionId)) return `evidence session ${e.sessionId} does not exist`;
  const p = (a.payload ?? {}) as Record<string, unknown>;
  let key: string;
  if (a.kind === "memory") {
    if (typeof p.content !== "string" || !p.content.trim()) return "memory payload needs content";
    if (p.key !== undefined && typeof p.key !== "string") return "memory payload key must be a string";
    key = slug(String(p.key ?? a.title));
  } else if (a.kind === "skill") {
    if (typeof p.name !== "string" || !slug(p.name)) return "skill payload needs name";
    if (typeof p.outline !== "string" || !p.outline.trim()) return "skill payload needs outline";
    key = slug(p.name);
  } else if (a.kind === "new_project") {
    if (typeof p.name !== "string" || typeof p.cwd !== "string" || !Array.isArray(p.sessionIds) || !p.sessionIds.every(Number.isSafeInteger)) return "new_project payload needs name, cwd, worker, sessionIds";
    key = slug(p.name);
  } else key = slug(a.title);
  if (!key) return "title or name gives an empty id";
  return { kind: a.kind, fingerprint: `${a.kind}:${key}`, title: a.title.trim().slice(0, 120), body: a.body.trim().slice(0, 1000), evidence: evidence.map(e => ({ sessionId: e.sessionId, note: e.note.slice(0, 200) })),
    payload: a.kind === "new_project" ? { worker: "main", ...p } : p, source: "model", ruleId: `model:${a.kind}` };
}

export function createWifeExtension(wife: () => WifeService | undefined, sessionExists: (id: number) => boolean) {
  return defineExtension({
    name: "wife",
    tools: [defineTool({
      name: "wife",
      description: "Wife suggestion cards. list shows open and dismissed cards so you do not file them again. suggest files one card (kind skill, memory, feature_tip, new_project) with evidence sessions. Filing again with the same name is safe.",
      parameters: Params,
      execute: async (a: Args) => {
        const w = wife();
        if (!w) return text("Error: Wife is disabled.", true);
        if (a.action === "list") {
          const rows = w.store.list().filter(c => c.status !== "done" || c.source === "model");
          return text(rows.length ? rows.map(c => `${c.fingerprint} [${c.status}] ${c.title}`).join("\n") : "(no cards)");
        }
        const card = buildCard(a, sessionExists);
        if (typeof card === "string") return text(`Error: ${card}`, true);
        const known = w.store.has(card.fingerprint);
        const filed = w.store.file(card, true);
        return text(filed ? `${known ? "Refreshed" : "Filed"} ${card.fingerprint}.` : `Skipped ${card.fingerprint}: already handled.`);
      },
    })],
  });
}
