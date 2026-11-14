// Composer: per-conversation drafts, attachments, durable submission with idempotency and retry.
// Port of vanilla composer.js.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { markRaw, reactive } from "vue";
import { api, json, post } from "@/lib/api";
import { draftsKey } from "@/lib/pane";
import { addErr, chat, createSession, entryList, putSideJob } from "./chat";
import { loadSessions } from "./sessions";

export interface Attachment {
  mimeType: string;
  data: string;
  url: string;
  uploadId?: string;
  name?: string;
  size?: number;
  report?: { jobName: string; id: number; status: string };
}
interface Draft { text: string; attachments: Attachment[] }
interface PendingMessage {
  requestId: string; session: string | null; epoch: number; content: any;
  status: "Sending…" | "Queued" | "Steering" | "Sent" | "Send not confirmed" | "Not delivered";
  mode?: "steer" | "followUp"; cancelling?: boolean;
  submissionId?: string; entryId?: number; promoting?: boolean;
}
// Local transport state only. Never add an unconfirmed message to durable history.
export const pendingMessages = reactive(new Map<string, PendingMessage>());
function pendingMessage(sid: string | null, body: any) {
  // Sending is explicit intent to follow, even when a retry adds no new pending row.
  // A background submission must not move the currently open conversation.
  if (chat.session === sid) chat.followTick++;
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
  if (pending.promoting && record.status === "unanswered" && record.reason === "aborted" && record.entry === undefined) return;
  if (record.status === "unanswered" && record.reason === "aborted" && record.entry === undefined) {
    pendingMessages.delete(pending.requestId);
    return;
  }
  pending.submissionId = String(record.id);
  // A receipt read can finish after a newer feed event.
  if (record.entry === undefined && (pending.entryId !== undefined || pending.status === "Not delivered")) return;
  if (record.entry !== undefined) pending.entryId = record.entry;
  pending.status = record.entry !== undefined ? "Sent" : record.status === "queued" ? (pending.mode === "steer" ? "Steering" : "Queued") : record.status === "unanswered" ? "Not delivered" : pending.status;
  if (composer.sendErrors.get(pending.session!)?.body.requestId === record.requestId) composer.sendErrors.delete(pending.session!);
}
/** Inbox mode is authoritative for inputs still waiting at a boundary. */
export function reconcileInbox(sid: string, items: { id: number | string; mode: "steer" | "followUp" }[]) {
  for (const pending of pendingMessages.values()) {
    if (pending.session !== sid || pending.entryId !== undefined) continue;
    const item = items.find(item => String(item.id) === pending.submissionId);
    if (!item) continue;
    pending.mode = item.mode;
    pending.status = item.mode === "steer" ? "Steering" : "Queued";
  }
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
  /** Freeze competing sends only until the outgoing snapshot is committed locally. */
  capturingBackground: false,
  attachments: [] as Attachment[],
  /** Number of uploads currently in flight. */
  uploadingCount: 0,
  /** Upload error message if the most recent upload failed. */
  uploadError: null as string | null,
  /** Conversations with an unconfirmed submission in flight. */
  submitting: new Set<string>(),
  /** Last failed submission per conversation, for "Retry send". */
  sendErrors: new Map<string, { body: any; message: string }>(),
});
// A route change must not interrupt a message whose delivery is still in flight.
window.addEventListener("luna:can-switch-connection", event => {
  if (composer.submitting.size || composer.uploadingCount > 0) {
    (event as CustomEvent).detail.error = "Wait for current uploads or sends to finish before switching addresses.";
  }
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

/** A generated widget suggests a prompt. It fills the composer only; the user still reviews and sends it. */
export function fillComposer(text: string) {
  const clean = text.slice(0, 2000).trim();
  if (!clean) return;
  composer.text = composer.text.trim() ? `${composer.text.trimEnd()}\n${clean}` : clean;
  saveDraft();
  document.getElementById("input")?.focus({ preventScroll: true });
}

// ---- attachments ----
const MAX_UPLOAD_SIZE = 32 * 1024 * 1024; // 32 MiB

export interface UploadMetadataResponse {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path?: string;
  ref?: string;
}

function isValidUploadMetadata(data: unknown): data is UploadMetadataResponse {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    /^[a-f0-9]{64}$/.test(d.id) &&
    typeof d.name === "string" && d.name.length > 0 &&
    typeof d.mimeType === "string" &&
    typeof d.size === "number" && Number.isSafeInteger(d.size) &&
    d.size >= 0 && d.size <= MAX_UPLOAD_SIZE
  );
}

export interface AddAttachmentContext {
  targetSession: string | null;
  targetAttachments: Attachment[];
}

export function captureAttachmentContext(): AddAttachmentContext {
  return {
    targetSession: chat.session,
    targetAttachments: composer.attachments,
  };
}

export async function addAttachment(file: File, context?: AddAttachmentContext) {
  if (file.size > MAX_UPLOAD_SIZE) {
    const err = `File exceeds 32 MB limit (${file.name})`;
    composer.uploadError = err;
    addErr(err);
    return;
  }

  const targetSession = context ? context.targetSession : chat.session;
  const targetAttachments = context ? context.targetAttachments : composer.attachments;

  // Initial capacity check before uploading
  if (targetAttachments.length >= 8) {
    const err = `At most 8 attachments per message (${file.name} not added).`;
    composer.uploadError = err;
    addErr(err);
    return;
  }

  composer.uploadingCount++;
  composer.uploadError = null;
  const localUrl = URL.createObjectURL(file);

  try {
    const uploadRes = await api(`/v1/uploads?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
      timeoutMs: 60000,
    });

    if (!uploadRes.ok) {
      const errBody = await uploadRes.json().catch(() => ({}));
      throw new Error(errBody.error || `Upload failed with status ${uploadRes.status}`);
    }

    const meta = await uploadRes.json();
    if (!isValidUploadMetadata(meta)) {
      throw new Error("Invalid upload metadata returned by server (expected id, name, mimeType, and numeric size)");
    }

    // Check capacity again in target list
    if (targetAttachments.length >= 8) {
      URL.revokeObjectURL(localUrl);
      const err = `At most 8 attachments per message (${meta.name} exceeded limit).`;
      composer.uploadError = err;
      addErr(err);
      return;
    }

    const attachmentRecord: Attachment = markRaw({
      mimeType: meta.mimeType || file.type || "application/octet-stream",
      data: "", // Backed by uploadId
      url: localUrl,
      uploadId: meta.id,
      name: meta.name || file.name,
      size: meta.size ?? file.size,
    });

    // Check if target is still active visible composer
    if (chat.session === targetSession && composer.attachments === targetAttachments) {
      targetAttachments.push(attachmentRecord);
      saveDraft();
    } else {
      // User navigated to another conversation; preserve in captured draft if draft exists
      const existingDraft = drafts.get(targetSession);
      if (existingDraft && existingDraft.attachments === targetAttachments) {
        if (targetAttachments.length < 8) {
          targetAttachments.push(attachmentRecord);
        } else {
          URL.revokeObjectURL(localUrl);
        }
      } else {
        // If the draft was completely discarded, do not drop silently; report clear error
        URL.revokeObjectURL(localUrl);
        const err = `Attachment ${meta.name} completed but draft for session was discarded.`;
        composer.uploadError = err;
        addErr(err);
      }
    }
  } catch (err) {
    URL.revokeObjectURL(localUrl);
    const msg = (err as Error).message || "Failed to upload file";
    composer.uploadError = msg;
    addErr(msg);
  } finally {
    composer.uploadingCount = Math.max(0, composer.uploadingCount - 1);
  }
}

export function removeAttachment(i: number) {
  const [a] = composer.attachments.splice(i, 1);
  if (a?.url) URL.revokeObjectURL(a.url);
  saveDraft();
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
        pending.mode = result.action === "steered" ? "steer" : "followUp";
        if (pending.entryId === undefined && ["Sending…", "Queued", "Steering"].includes(pending.status))
          pending.status = result.action === "steered" ? "Steering" : result.action === "queued" ? "Queued" : "Sent";
        void refreshPending(sid);
      }
    }
    if (chat.session === sid && result) {
      if (result.job) {
        const old = chat.sideJobs.get(result.job.id);
        if (!old || old.status === "running") putSideJob(result.job);
      }
      const lines = [result.job?.kind === "review" ? undefined : result.notice, ...(result.queue || []).map((row: any) => `${row.number}. ${typeof row.content === "string" ? row.content : JSON.stringify(row.content)}`)].filter(Boolean);
      // UI-only feedback: never submit command notices as model-visible messages.
      if (lines.length) addErr(lines.join("\n"), "muted");
    }
    composer.sendErrors.delete(sid);
    return true;
  } catch (e) {
    // The feed can confirm a send even when its HTTP response is lost.
    if (pending?.submissionId) { composer.sendErrors.delete(sid); return true; }
    if (pending && pendingMessages.get(body.requestId) === pending && pending.status === "Sending…") pending.status = "Send not confirmed";
    if ((e as Error).message !== "unauthorized") {
      const err = e as Error;
      const isTimeout = err.name === "TimeoutError" || /timed?\s*out/i.test(err.message);
      const message = isTimeout
        ? "Request timed out; delivery not confirmed. The server may still have received the message."
        : err.message;
      composer.sendErrors.set(sid, { body, message });
    }
    return false;
  } finally {
    composer.submitting.delete(sid);
    loadSessions().catch(() => {});
  }
}
/** Turn a queued message into a steer of the current run. A retry uses the same replacement request ID, never a second input. */
export async function steerPending(requestId: string) {
  const pending = pendingMessages.get(requestId);
  if (!pending?.session || !pending.submissionId || pending.status !== "Queued" || composer.submitting.has(pending.session)) return;
  const sid = pending.session;
  pending.promoting = true;
  composer.submitting.add(sid);
  try {
    const result = await post(`/v1/sessions/${sid}/submissions/${encodeURIComponent(pending.submissionId)}/steer`, { content: pending.content });
    if (result.submissionId === undefined) throw new Error(result.notice || "Message promotion was not accepted.");
    pendingMessages.delete(requestId);
    const replacementId = `steer:${pending.submissionId}`;
    pendingMessages.set(replacementId, { ...pending, promoting: false, requestId: replacementId, submissionId: String(result.submissionId), mode: "steer", status: result.action === "steered" ? "Steering" : result.action === "queued" ? "Queued" : "Sent" });
    void refreshPending(sid);
  } catch (error) {
    // A lost response may already have replaced the original. Resolve that ID before exposing Cancel.
    const replacementId = `steer:${pending.submissionId}`;
    const record = await json(`/v1/sessions/${sid}/submissions/by-request/${encodeURIComponent(replacementId)}`).catch(() => null);
    if (record) {
      pendingMessages.delete(requestId);
      pendingMessages.set(replacementId, { ...pending, promoting: false, requestId: replacementId, submissionId: String(record.id), mode: "steer", status: "Steering" });
      reconcileSubmission(record);
      void refreshPending(sid);
    }
    // Otherwise keep Steer retryable with its stable ID; cancellation must not target the superseded input.
    if (chat.session === sid) addErr((error as Error).message);
  } finally {
    composer.submitting.delete(sid);
  }
}
/** Confirm durable withdrawal before removing the card. A lost response is safe to retry. */
export async function cancelPending(requestId: string) {
  const pending = pendingMessages.get(requestId);
  if (!pending?.session || !pending.submissionId || pending.promoting || !["Queued", "Steering"].includes(pending.status) || composer.submitting.has(pending.session)) return;
  const sid = pending.session;
  pending.cancelling = true;
  composer.submitting.add(sid);
  try {
    await post(`/v1/sessions/${sid}/submissions/${encodeURIComponent(pending.submissionId)}/cancel`, {});
    pendingMessages.delete(requestId);
  } catch (error) {
    await refreshPending(sid);
    // A receipt/feed can confirm cancellation despite a lost HTTP response.
    if (chat.session === sid && (pendingMessages.has(requestId) || (error as { status?: number }).status === 409))
      addErr((error as Error).message);
  } finally {
    pending.cancelling = false;
    composer.submitting.delete(sid);
  }
}
export function retrySend() {
  const sid = chat.session, error = sid ? composer.sendErrors.get(sid) : undefined;
  if (sid && error) void submitMessage(sid, error.body);
}
export function canRecoverPending(message: PendingMessage): boolean {
  return message.status === "Send not confirmed" || message.status === "Not delivered";
}
/** Remove only the local echo. An unconfirmed request may still reach the server. */
export function dismissPending(requestId: string) {
  const pending = pendingMessages.get(requestId);
  if (!pending?.session || !canRecoverPending(pending) || composer.submitting.has(pending.session)) return;
  pendingMessages.delete(requestId);
  if (composer.sendErrors.get(pending.session)?.body.requestId === requestId) composer.sendErrors.delete(pending.session);
}
export function retryPending(requestId: string) {
  const pending = pendingMessages.get(requestId);
  if (!pending?.session || !canRecoverPending(pending) || composer.submitting.has(pending.session)) return;
  const sid = pending.session;
  // Unknown delivery must reuse its ID. A terminal unanswered receipt needs a new request.
  const body = { content: pending.content, requestId: pending.status === "Not delivered" ? randomId() : requestId };
  if (body.requestId !== requestId) dismissPending(requestId);
  void submitMessage(sid, body);
}
export function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c =>
      (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16));
  }
  return "req-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

export function buildMessageContent(text: string, atts: Attachment[]): any {
  return atts.length
    ? [
        ...(text ? [{ type: "text", text }] : []),
        ...atts.map(a => {
          if (a.report) {
            return { type: "text", text: a.data };
          }
          if (a.uploadId) {
            return {
              type: "file",
              uploadId: a.uploadId,
              attachment: {
                id: a.uploadId,
                name: a.name || "upload",
                mimeType: a.mimeType || "application/octet-stream",
                size: a.size || 0,
              },
            };
          }
          return {
            type: a.mimeType.startsWith("audio/") ? "audio" : "image",
            data: a.data,
            mimeType: a.mimeType,
          };
        }),
      ]
    : text;
}

export async function send(text: string, atts: Attachment[]) {
  let sid = chat.session;
  if (sid && composer.submitting.has(sid)) return;
  const content = buildMessageContent(text, atts);

  for (const a of atts) {
    if (a.url) URL.revokeObjectURL(a.url);
  }
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
  if (composer.uploadingCount > 0 || composer.capturingBackground) return;
  const text = composer.text.trim();
  if (!text && !composer.attachments.length) return;
  const atts = composer.attachments;
  composer.attachments = []; composer.text = ""; saveDraft();
  const epoch = chat.epoch;
  send(text, atts).catch(error => { if (epoch === chat.epoch) addErr((error as Error).message); });
}
