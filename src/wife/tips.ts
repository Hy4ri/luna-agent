// Feature tips: data rules matched against tool-call counts. The catalog lives in config (`wife.tips`), so m57 can edit it.
import { z } from "zod";
import type { NewSuggestion } from "./store.js";

export const TipSchema = z.strictObject({
  id: z.string().min(1).regex(/^[a-z0-9_-]+$/, "use lowercase letters, digits, - and _"),
  title: z.string().min(1), body: z.string().min(1), docs: z.string().min(1).optional(),
  /** Fire when `tool` has at least `minCalls` calls in at least `minSessions` sessions within `withinDays`, and `withoutTool` has none. */
  when: z.strictObject({
    tool: z.string().min(1), minCalls: z.number().int().min(1).default(50), minSessions: z.number().int().min(1).default(5),
    withinDays: z.number().int().min(1).max(365).default(30), withoutTool: z.string().min(1).optional(),
    /** Which analytics facts `tool` and `withoutTool` name. Default: tool calls. */
    kind: z.enum(["tool", "skill", "compaction"]).default("tool"),
    /** Count only sessions of this project id, or whose cwd contains this text. */
    project: z.number().int().min(0).optional(), cwd: z.string().min(1).optional(),
    /** Fire only when the newest matching session has been idle for at least this many days. */
    idleDays: z.number().int().min(1).max(365).optional(),
  }),
  /** `shadow` rules only log what they would flag. A shadow rule that Wife proposed becomes `on` when you agree to its promote card. */
  status: z.enum(["on", "shadow"]).default("on"),
  shadowSince: z.number().int().optional(),
  /** Agree turns this extension on through settings. */
  enable: z.strictObject({ extension: z.string().min(1) }).optional(),
});
export type WifeTip = z.infer<typeof TipSchema>;

export const DEFAULT_TIPS: WifeTip[] = [
  { id: "codemode", title: "Try codemode for batch tool work",
    body: "You call bash a lot, and you never use codemode. One codemode script can run many tool calls and return only the result you need.",
    when: { tool: "bash", minCalls: 100, minSessions: 5, withinDays: 30, withoutTool: "codemode", kind: "tool" }, status: "on", enable: { extension: "codemode" } },
  { id: "background-processes", title: "Run long commands in the background",
    body: "You call bash a lot, and you never use process_manage. Background mode returns at once and wakes the chat when the command ends.",
    when: { tool: "bash", minCalls: 100, minSessions: 5, withinDays: 30, withoutTool: "process_manage", kind: "tool" }, status: "on" },
  { id: "subagents", title: "Delegate side work to subagents",
    body: "You run long tool-heavy sessions and never use subagent. A subagent does a side task in its own context and returns only the answer, so the main session stays small.",
    when: { tool: "bash", minCalls: 300, minSessions: 8, withinDays: 30, withoutTool: "subagent", kind: "tool" }, status: "on" },
  { id: "crew", title: "Try a crew for parallel work",
    body: "You run many heavy sessions and never use session_crew. A crew lets one lead session hand tasks to full sessions you can watch in the sidebar.",
    when: { tool: "bash", minCalls: 300, minSessions: 8, withinDays: 30, withoutTool: "session_crew", kind: "tool" }, status: "on" },
];

export type ToolCounts = Map<string, { calls: number; sessions: number }>;

/** `counts` must cover the widest window of any tip; `countsIn` gives the counts for one window. */
export function matchTips(tips: WifeTip[], countsIn: (withinDays: number, kind: WifeTip["when"]["kind"], tip: WifeTip) => ToolCounts, enabled: (extension: string) => boolean = () => false, shadow = false, idleDays: (tip: WifeTip) => number | null = () => null): NewSuggestion[] {
  const out: NewSuggestion[] = [];
  for (const t of tips) {
    if ((t.status === "shadow") !== shadow) continue;
    const counts = countsIn(t.when.withinDays, t.when.kind, t);
    if (t.when.idleDays !== undefined) { const idle = idleDays(t); if (idle === null || idle < t.when.idleDays) continue; }
    const used = counts.get(t.when.tool);
    if (!used || used.calls < t.when.minCalls || used.sessions < t.when.minSessions) continue;
    if (t.when.withoutTool && (counts.get(t.when.withoutTool)?.calls ?? 0) > 0) continue;
    if (t.enable && enabled(t.enable.extension)) continue;
    out.push({ kind: "feature_tip", ruleId: `tip:${t.id}`, fingerprint: `feature_tip:${t.id}`, source: "detector", title: t.title,
      body: `${t.body}\n\n${t.when.tool}: ${used.calls} calls in ${used.sessions} sessions over ${t.when.withinDays} days.`,
      evidence: [], payload: { tipId: t.id, docs: t.docs ?? null, enable: t.enable?.extension ?? null } });
  }
  return out;
}
