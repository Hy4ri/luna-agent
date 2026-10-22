// Composer: per-conversation drafts, attachments, durable submission with idempotency and retry.
// Port of vanilla composer.js.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { markRaw, reactive } from "vue";
import { json, post } from "@/lib/api";
import { draftsKey } from "@/lib/pane";
import { addErr, chat, createSession, entryList, putSideJob } from "./chat";
import { loadSessions } from "./sessions";

export interface Attachment { mimeType: string; data: string; url: string }
interface Draft { text: string; attachments: Attachment[] }
interface PendingMessage {
  requestId: string; session: string | null; epoch: number; content: any;
  status: "Sending…" | "Queued" | "Sent" | "Send not confirmed" | "Not delivered";
  submissionId?: string; entryId?: number;
}
// Local transport state only. Never add an unconfirmed message to durable history.
export const pendingMessages = reactive(new Map<string, PendingMessage>());
function pendingMessage(sid: string | null, body: any) {
  // Commands can change or omit the model-visible input; only echo ordinary messages.
  const text = typeof body.content === "string" ? body.content : (body.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  if (!body.requestId || text.trimStart().startsWith("/")) return;
  let pending = pendingMessages.get(body.requestId);
  if (!pending) {
    pendingMessages.set(body.requestId, { requestId: body.requestId, session: sid, epoch: chat.epoch, content: body.content, status: "Sending…" });
    pending = pendingMessages.get(body.requestId)!;
  }
  pending.session = sid; pending.status = "Sending…";
  return pending;
}
/** Reconcile by the durable request/entry IDs, never by message text. */
export function reconcileSubmission(record: any) {
  const pending = record.requestId && pendingMessages.get(record.requestId);
  if (!pending || String(record.conversationId) !== pending.session) return;
  pending.submissionId = String(record.id);
  // A receipt read can finish after a newer feed event.
  if (record.entry === undefined && (pending.entryId !== undefined || pending.status === "Not delivered")) return;
  if (record.entry !== undefined) pending.entryId = record.entry;
  pending.status = record.entry !== undefined ? "Sent" : record.status === "queued" ? "Queued" : record.status === "unanswered" ? "Not delivered" : pending.status;
  if (composer.sendErrors.get(pending.session!)?.body.requestId === record.requestId) composer.sendErrors.delete(pending.session!);
}
export function retirePendingEntries(sid: string, ids: Set<number>) {
  for (const [key, pending] of pendingMessages) {
    if (pending.session === sid && pending.entryId !== undefined && ids.has(pending.entryId)) pendingMessages.delete(key);
  }
}
/** A reconnect snapshot does not replay submission events. Read any outstanding receipts. */
export async function refreshPending(sid: string) {
  await Promise.all([...pendingMessages.values()].filter(p => p.session === sid && p.submissionId).map(async p => {
    const record = await json(`/v1/submissions/${encodeURIComponent(p.submissionId!)}`).catch(() => null);
    if (record && pendingMessages.get(p.requestId) === p) reconcileSubmission(record);
  }));
  if (chat.session === sid) retirePendingEntries(sid, new Set(entryList.value.map(e => e.id)));
}

const drafts = new Map<string | null, Draft>();
try {
  for (const [id, text] of JSON.parse(sessionStorage.getItem(draftsKey) || "[]")) {
    if ((id === null || typeof id === "string") && typeof text === "string") drafts.set(id, { text, attachments: [] });
  }
} catch {}

export const composer = reactive({
  text: "",
  attachments: [] as Attachment[],
  /** Conversations with an unconfirmed submission in flight. */
  submitting: new Set<string>(),
  /** Last failed submission per conversation, for "Retry send". */
  sendErrors: new Map<string, { body: any; message: string }>(),
});
const draftTextKey = (id: string | null) => `luna.draft.${id ?? "new"}`;
let owner: string | null | undefined; // conversation the visible draft belongs to

export function saveDraft() {
  if (owner === undefined) return;
  drafts.set(owner, { text: composer.text, attachments: composer.attachments });
  try { sessionStorage.setItem(draftTextKey(owner), composer.text); } catch {}
}
export function restoreDraft() {
  owner = chat.session;
  const draft = drafts.get(owner);
  let text = draft?.text || "";
  try { text = sessionStorage.getItem(draftTextKey(owner)) ?? text; } catch {}
  composer.text = text; composer.attachments = draft?.attachments || [];
}

// ---- attachments ----
export async function addAttachment(file: File) {
  const target = composer.attachments, from = chat.session;
  if (!/^(image\/(png|jpeg|gif|webp)|audio\/(mpeg|mp3|wav|x-wav|ogg|webm|mp4|flac))$/.test(file.type)) return addErr("Unsupported image or audio type.");
  if (target.length >= 8) return addErr("At most 8 attachments per message.");
  const blob = file.type.startsWith("audio/") ? file : await shrink(file);
  const data = await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(",")[1]); fr.readAsDataURL(blob); });
  if (target.length >= 8) return;
  target.push(markRaw({ mimeType: blob.type, data, url: URL.createObjectURL(blob) }));
  void from;
}
export function removeAttachment(i: number) {
  const [a] = composer.attachments.splice(i, 1);
  if (a) URL.revokeObjectURL(a.url);
}
// Downscale big photos to 2000px max so uploads stay small; GIFs pass through.
async function shrink(file: File): Promise<Blob> {
  if (file.type === "image/gif") return file;
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp || Math.max(bmp.width, bmp.height) <= 2000) return file;
  const k = 2000 / Math.max(bmp.width, bmp.height);
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(b => r(b || file), "image/jpeg", 0.88));
}

// ---- submission ----
export async function submitMessage(sid: string, body: any) {
  if (composer.submitting.has(sid)) return false;
  composer.submitting.add(sid);
  const pending = pendingMessage(sid, body);
  try {
    const result = await post(`/v1/sessions/${sid}/messages?async=1`, body);
    if (pending && pendingMessages.get(body.requestId) === pending) {
      if (result.command) pendingMessages.delete(body.requestId);
      else if (result.submissionId !== undefined) {
        pending.submissionId = String(result.submissionId);
        if (pending.status === "Sending…") pending.status = result.action === "queued" ? "Queued" : "Sent";
        void refreshPending(sid);
      }
    }
    if (chat.session === sid && result) {
      if (result.job) {
        const old = chat.sideJobs.get(result.job.id);
        if (!old || old.status === "running") putSideJob(result.job);
      }
      const lines = [result.notice, ...(result.queue || []).map((row: any) => `${row.number}. ${typeof row.content === "string" ? row.content : JSON.stringify(row.content)}`)].filter(Boolean);
      if (lines.length) chat.busyFeedback = lines.join("\n");
    }
    composer.sendErrors.delete(sid);
    return true;
  } catch (e) {
    // The feed can confirm a send even when its HTTP response is lost.
    if (pending?.submissionId) { composer.sendErrors.delete(sid); return true; }
    if (pending && pendingMessages.get(body.requestId) === pending && pending.status === "Sending…") pending.status = "Send not confirmed";
    if ((e as Error).message !== "unauthorized") composer.sendErrors.set(sid, { body, message: (e as Error).message });
    return false;
  } finally {
    composer.submitting.delete(sid);
    loadSessions().catch(() => {});
  }
}
export function retrySend() {
  const sid = chat.session, error = sid ? composer.sendErrors.get(sid) : undefined;
  if (sid && error) void submitMessage(sid, error.body);
}
function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c =>
      (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16));
  }
  return "req-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}
export async function send(text: string, atts: Attachment[]) {
  let sid = chat.session;
  if (sid && composer.submitting.has(sid)) return;
  const content = atts.length ? [...(text ? [{ type: "text", text }] : []), ...atts.map(a => ({ type: a.mimeType.startsWith("audio/") ? "audio" : "image", data: a.data, mimeType: a.mimeType }))] : text;
  for (const a of atts) URL.revokeObjectURL(a.url);
  const body = { content, requestId: randomId() };
  const pending = pendingMessage(sid, body);
  try {
    if (!sid) {
      const id = await createSession(chat.project);
      if (!id) { pendingMessages.delete(body.requestId); return; }
      sid = String(id);
      if (pending) pending.session = sid;
    }
    await submitMessage(sid, body);
  } catch (error) {
    pendingMessages.delete(body.requestId);
    throw error;
  }
}
/** Form submit: takes the draft and sends it. The caller checks the send button state. */
export function submitDraft() {
  const text = composer.text.trim();
  if (!text && !composer.attachments.length) return;
  const atts = composer.attachments;
  composer.attachments = []; composer.text = ""; saveDraft();
  const epoch = chat.epoch;
  send(text, atts).catch(error => { if (epoch === chat.epoch) addErr((error as Error).message); });
}
