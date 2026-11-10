// `ask_user_question`: a port of @juicesharp/rpiv-ask-user-question (MIT, most-downloaded Pi ask-user package).
// Same schema, validation and answer envelope. Instead of a terminal dialog, the open questionnaire is stored in a
// conversation document; the web UI renders it and answers through POST /v1/sessions/:id/questions/:callId.
// The tool call waits durably (replay-safe: after a restart it waits again for the same question).
import { Type, type Static } from "typebox";
import { defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { StringEnum } from "./string-enum.js";

export const MAX_QUESTIONS = 4, MIN_OPTIONS = 2, MAX_OPTIONS = 4, MAX_HEADER = 16, MAX_LABEL = 60, MAX_CONTEXT = 600;
const RESERVED = new Set(["Other", "Type something.", "Next"]);

const Option = Type.Object({
  label: Type.String({ maxLength: MAX_LABEL, description: `MAX ${MAX_LABEL} CHARACTERS. The display text for this option (1-5 words).` }),
  description: Type.String({ description: "What this option means or what happens if chosen; trade-offs." }),
  preview: Type.Optional(Type.String({ description: "Optional markdown shown beside the option (mockup, code, config). Single-select only." })),
});
const Question = Type.Object({
  question: Type.String({ description: "The complete question, ending with a question mark." }),
  context: Type.Optional(Type.String({ maxLength: MAX_CONTEXT, description: `MAX ${MAX_CONTEXT} CHARACTERS. Optional markdown shown under the question: why you ask, constraints, and your recommendation. Keep the question itself to one line.` })),
  header: Type.String({ maxLength: MAX_HEADER, description: `MAX ${MAX_HEADER} CHARACTERS. Very short chip shown next to the question, e.g. "Auth method".` }),
  options: Type.Array(Option, { minItems: MIN_OPTIONS, maxItems: MAX_OPTIONS, description: "2-4 distinct choices. A free-text answer row is appended automatically; do NOT author it." }),
  multiSelect: Type.Optional(Type.Boolean({ default: false, description: "Allow selecting several options." })),
});
export const AskParams = Type.Object({ purpose: Type.Optional(StringEnum(["input", "approval"], { description: "Use approval when requesting permission; otherwise input (default)." })), questions: Type.Array(Question, { minItems: 1, maxItems: MAX_QUESTIONS, description: "Questions to ask the user (1-4)" }) });
export type AskArgs = Static<typeof AskParams>;

export type QuestionAnswer = {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "multi";
  answer: string | null;
  selected?: string[];
  notes?: string;
  preview?: string;
};
export type AskResult = { answers: QuestionAnswer[]; cancelled: boolean; globalNote?: string };
type Q = { question: string; context?: string; header: string; options: { label: string; description: string; preview?: string }[]; multiSelect?: boolean };
export type PendingAsk = { purpose?: "input" | "approval"; callId: string; questions: Q[]; at: number };

/** Open questionnaires and their answers, per conversation. Answers are removed once the tool reads them. */
export const AskDoc = defineDoc<{ pending: PendingAsk[]; answers: Record<string, AskResult> }>({
  checkpointWhen: () => false,
  kind: "luna.ask",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ pending: [], answers: {} }),
});

export function validateQuestions(a: AskArgs): string | undefined {
  const seen = new Set<string>();
  for (const q of a.questions) {
    if (seen.has(q.question)) return "Error: Question text must be unique within an invocation";
    seen.add(q.question);
    if (q.options.length < MIN_OPTIONS) return `Error: Each question requires at least ${MIN_OPTIONS} options`;
    const labels = new Set<string>();
    for (const o of q.options) {
      if (RESERVED.has(o.label)) return `Error: Option label is reserved (${[...RESERVED].join(", ")})`;
      if (labels.has(o.label)) return "Error: Option labels must be unique within a question";
      labels.add(o.label);
    }
  }
  return undefined;
}

/** Check an answer from the (untrusted) web client against the open questionnaire; returns the normalized result. */
export function checkAnswer(p: PendingAsk, body: unknown): AskResult | string {
  const b = body as Partial<AskResult> | null;
  if (!b || typeof b !== "object") return "answer body required";
  if (b.cancelled === true) return { answers: [], cancelled: true, ...(typeof b.globalNote === "string" && b.globalNote.trim() ? { globalNote: b.globalNote.trim() } : {}) };
  if (!Array.isArray(b.answers)) return "answers (array) required";
  const out: QuestionAnswer[] = [];
  for (const a of b.answers as QuestionAnswer[]) {
    const q = p.questions[a?.questionIndex];
    if (!q) return `questionIndex ${a?.questionIndex} out of range`;
    if (out.some((x) => x.questionIndex === a.questionIndex)) return "duplicate questionIndex";
    const labels = new Set(q.options.map((o) => o.label));
    const notes = typeof a.notes === "string" && a.notes.trim() ? { notes: a.notes.trim() } : {};
    if (a.kind === "option") {
      if (typeof a.answer !== "string" || !labels.has(a.answer)) return `unknown option for question ${a.questionIndex}`;
      const preview = q.options.find((o) => o.label === a.answer)?.preview;
      out.push({ questionIndex: a.questionIndex, question: q.question, kind: "option", answer: a.answer, ...(preview && !q.multiSelect ? { preview } : {}), ...notes });
    } else if (a.kind === "custom") {
      if (typeof a.answer !== "string" || !a.answer.trim()) return `empty custom answer for question ${a.questionIndex}`;
      out.push({ questionIndex: a.questionIndex, question: q.question, kind: "custom", answer: a.answer.trim(), ...notes });
    } else if (a.kind === "multi") {
      if (!q.multiSelect) return `question ${a.questionIndex} is single-select`;
      const sel = Array.isArray(a.selected) ? a.selected : [];
      if (sel.some((s) => !labels.has(s))) return `unknown option for question ${a.questionIndex}`;
      const custom = typeof a.answer === "string" && a.answer.trim() ? a.answer.trim() : null;
      if (!sel.length && !custom) continue;
      out.push({ questionIndex: a.questionIndex, question: q.question, kind: "multi", answer: custom, selected: [...new Set(sel)], ...notes });
    } else return `invalid answer kind for question ${a?.questionIndex}`;
  }
  return { answers: out, cancelled: false, ...(typeof b.globalNote === "string" && b.globalNote.trim() ? { globalNote: b.globalNote.trim() } : {}) };
}

const scalar = (a: QuestionAnswer) => a.kind === "multi" ? [...(a.selected ?? []), ...(a.answer ? [a.answer] : [])].join(", ") || "(no input)" : a.answer ?? "(no input)";

/** rpiv-ask-user-question's answer envelope, word for word. */
export function envelope(r: AskResult, questions: AskArgs["questions"]): string {
  if (r.cancelled) return "User declined to answer questions";
  const seg: string[] = [], missing: number[] = [];
  questions.forEach((_q, i) => {
    const a = r.answers.find((x) => x.questionIndex === i);
    if (!a) return void missing.push(i);
    const parts = [`"${a.question}"="${scalar(a)}"`];
    if (a.preview) parts.push(`selected preview: ${a.preview}`);
    if (a.notes) parts.push(`user notes: ${a.notes}`);
    seg.push(`${parts.join(". ")}.`);
  });
  if (!seg.length && !r.globalNote) return "User declined to answer questions";
  if (missing.length) seg.push(`unanswered: ${missing.map((i) => `"${questions[i]?.question}"`).join(", ")}.`);
  if (r.globalNote) seg.push(`global note: ${r.globalNote}.`);
  return `User has answered your questions: ${seg.join(" ")} You can now continue with the user's answers in mind.`;
}

const DESCRIPTION = [
  "Ask the user one or more structured questions during execution: preferences, ambiguous instructions, implementation choices, direction. The user answers in the Luna web UI; the call waits until they do.",
  `- Up to ${MAX_QUESTIONS} questions per call, each with ${MIN_OPTIONS}-${MAX_OPTIONS} options (concise label + description). The user can always type their own answer or decline; do NOT author "Other" or "Type something." labels.`,
  "- context: optional short markdown under one question that says why you ask and what you recommend. Use it instead of a long question.",
  "- multiSelect: true when several answers are valid. options[].preview adds markdown to compare concrete artifacts (single-select only).",
  "- If you recommend an option, put it first and append \"(Recommended)\" to its label.",
  "- Group all clarifying questions into one call. Do not use it in unattended (cron) runs.",
].join("\n");

export interface AskOptions {
  /** How long to wait for an answer. Default 6 hours. */
  timeoutMs?: number;
  /** Called once when a questionnaire opens (e.g. a push notification). Errors are ignored. */
  onAsk?: (conversationId: number, p: PendingAsk) => void | Promise<void>;
  pollMs?: number;
}

export function createAskExtension(o: AskOptions = {}) {
  const timeoutMs = o.timeoutMs ?? 6 * 3600_000, pollMs = o.pollMs ?? 400;
  return defineExtension({
    name: "ask-user",
    tools: [
      defineTool({
        name: "ask_user_question",
        description: DESCRIPTION,
        parameters: AskParams,
        replay: "safe",
        execute: async (args, api, context) => {
          const bad = validateQuestions(args);
          if (bad) return { output: [{ type: "text", text: bad }], isError: true };
          const callId = api.callId;
          const opened = await api.commit(async (tx) => {
            const doc = await tx.doc(AskDoc, api.conversationId);
            if (doc.pending.some((p) => p.callId === callId) || doc.answers[callId]) return false;
            doc.pending.push({ callId, purpose: args.purpose ?? "input", questions: JSON.parse(JSON.stringify(args.questions)), at: Date.now() } as never);
            return true;
          }, context);
          if (opened && o.onAsk) void Promise.resolve(o.onAsk(api.conversationId as number, { callId, questions: args.questions, at: Date.now() })).catch(() => {});
          const deadline = Date.now() + timeoutMs;
          const close = () => api.commit(async (tx) => {
            const doc = await tx.doc(AskDoc, api.conversationId);
            const i = doc.pending.findIndex((p) => p.callId === callId);
            if (i >= 0) doc.pending.splice(i, 1);
            const r = doc.answers[callId] as AskResult | undefined;
            delete doc.answers[callId];
            return r ? (JSON.parse(JSON.stringify(r)) as AskResult) : undefined;
          }, context);
          try {
            for (;;) {
              const snap = await api.snapshot(AskDoc, api.conversationId, context);
              if (snap?.answers[callId]) {
                const r = (await close()) ?? { answers: [], cancelled: true };
                return { output: [{ type: "text", text: envelope(r, args.questions) }], details: r as never };
              }
              if (Date.now() > deadline) {
                await close();
                return { output: [{ type: "text", text: "No answer: the user did not respond in time. Continue with your best judgment or ask again later." }], isError: true };
              }
              if (context.abortSignal?.aborted) throw new Error("aborted");
              await new Promise((r) => setTimeout(r, pollMs));
            }
          } catch (e) {
            if (context.abortSignal?.aborted) await close().catch(() => {});
            throw e;
          }
        },
      }),
    ],
  });
}
