// Quick-create transport only: normal independent sessions, no source relationship.
import { reactive, watch } from "vue";
import { json, serverUrl, token, type HttpError } from "@/lib/api";
import { chat } from "./chat";
import { composer, randomId, buildMessageContent, saveDraft } from "./composer";
import { models, LEVELS, modelByKey } from "./models";
import { loadSessions } from "./sessions";
import { getTargetScope } from "@/lib/background-identity";
import { type BackgroundSendRecord as Record, putOutboxRecord, getOutboxRecord, listOutboxRecords,
  deleteOutboxRecord, claimOutboxRecord, saveClaimedRecord, releaseOutboxClaim } from "@/lib/background-outbox";

export interface BackgroundSendItem {
  id: string; status: "sending" | "accepted" | "error" | "uncertain";
  sessionId?: string; message?: string; busy: boolean;
}
export const backgroundSends = reactive<BackgroundSendItem[]>([]);
const clientId = randomId();
let scopeGeneration = 0;
const active = new Set<string>();
const successTimers = new Map<string, ReturnType<typeof setTimeout>>();
const currentScope = () => getTargetScope(serverUrl.value || location.origin, token.value);
function display(record: Record, recovered = false) {
  const accepted = record.state === "accepted";
  const busy = !recovered && active.has(record.id);
  const item: BackgroundSendItem = { id: record.id, sessionId: record.sessionId ?? undefined,
    status: accepted ? "accepted" : busy ? "sending" : record.sessionId ? "uncertain" : "error", busy,
    message: accepted ? record.notice : record.error ?? (recovered ? "Delivery unconfirmed. Retry to continue." : undefined) };
  const index = backgroundSends.findIndex(row => row.id === record.id);
  if (index < 0) backgroundSends.push(item); else backgroundSends[index] = item;
  if (accepted && !successTimers.has(record.id)) {
    successTimers.set(record.id, setTimeout(() => {
      successTimers.delete(record.id);
      const row = backgroundSends.findIndex(r => r.id === record.id);
      if (row >= 0) backgroundSends.splice(row, 1);
      void deleteOutboxRecord(record.id).catch(() => {});
    }, 10_000));
  }
}
async function lookup<T>(path: string): Promise<T | undefined> {
  try { return await json<T>(path); }
  catch (error) { if ((error as HttpError).status === 404) return undefined; throw error; }
}
const creationPath = (r: Record) => `/v1/session-creations/${encodeURIComponent(r.creationRequestId)}`;
const receiptPath = (r: Record) => `/v1/sessions/${r.sessionId}/${r.payload?.isCommand ? "background-commands" : "submissions/by-request"}/${encodeURIComponent(r.messageRequestId)}`;
function content(r: Record) {
  if (!r.payload) throw new Error("Saved message is unavailable.");
  return buildMessageContent(r.payload.text, r.payload.attachments.map(a => ({ ...a, url: "" })));
}
async function confirmReceipt(r: Record): Promise<boolean> {
  if (!r.sessionId || !r.payload) return r.state === "accepted";
  const receipt = await lookup<{ state?: string; status?: number | string; result?: { notice?: string; error?: string }; id?: number; entry?: number; reason?: string }>(receiptPath(r));
  if (!receipt) return false;
  if (r.payload.isCommand) {
    if (receipt.state === "pending") throw new Error("Command delivery is uncertain. Open the new session to inspect it; the command will not be repeated.");
    if (typeof receipt.status !== "number" || receipt.status >= 400)
      throw new Error(receipt.result?.error ?? "The command was rejected. Open the new session to inspect it.");
    r.notice = receipt.result?.notice;
  } else {
    if (receipt.status === "unanswered" && receipt.entry === undefined)
      throw new Error(`Message was not delivered (${receipt.reason ?? "unanswered"}). Open the new session to inspect it.`);
    if (!receipt.id) return false;
  }
  r.state = "accepted"; r.error = null; r.payload = null;
  return true;
}

export async function captureBackgroundSend(project?: number | null): Promise<boolean> {
  if (composer.capturingBackground) return false;
  if (chat.booting || chat.bootError || (chat.session && !chat.connected))
    throw new Error("Wait for the session settings to load before sending in background.");
  const text = composer.text.trim();
  const attachmentList = [...composer.attachments];
  if (composer.uploadingCount) throw new Error("Wait for uploads to finish before sending in background.");
  if (!text && !attachmentList.length) return false;
  if (/^\/(models?|compact|compress)(?:\s|$)/i.test(text))
    throw new Error("This command is available only in the visible session. Use normal Send.");
  const model = models.selected ?? models.draft.model ?? models.defaultModel;
  if (!model || !modelByKey(model.provider + "/" + model.modelId))
    throw new Error("Choose an available model before sending in background.");
  if (!(LEVELS as readonly string[]).includes(models.thinking))
    throw new Error("Choose a valid thinking level before sending in background.");
  // Everything mutable is captured before the first await.
  const snapshot = { project: project === undefined ? chat.project : project, model: { ...model },
    thinking: models.thinking, ...(models.speed ? { speed: models.speed } : {}), worker: chat.session ? chat.machine?.id ?? null : chat.draftWorker,
    cwd: chat.session ? chat.cwd ?? "" : chat.draftCwd };
  const originalText = composer.text, epoch = chat.epoch;
  const origin = serverUrl.value, credential = token.value;
  const attachments = attachmentList.map(({ mimeType, data, uploadId, name, size, report }) =>
    ({ mimeType, data, uploadId, name, size, report: report ? { ...report } : undefined }));
  composer.capturingBackground = true;
  try {
    const scope = await getTargetScope(origin || location.origin, credential);
    if (origin !== serverUrl.value || credential !== token.value) throw new Error("Connection changed. The draft was not sent.");
    if (!snapshot.cwd) {
      const params = new URLSearchParams();
      if (snapshot.project !== null) params.set("project", String(snapshot.project));
      if (snapshot.worker !== null) params.set("worker", String(snapshot.worker));
      const defaults = await json<{ cwd: string; worker: number | null }>(`/v1/session-defaults?${params}`);
      if (!defaults.cwd) throw new Error("The working directory is unavailable. The draft was not sent.");
      snapshot.cwd = defaults.cwd;
    }
    if (origin !== serverUrl.value || credential !== token.value) throw new Error("Connection changed. The draft was not sent.");
    const record: Record = { id: randomId(), creationRequestId: randomId(), messageRequestId: randomId(), scope,
      createdAt: Date.now(), updatedAt: Date.now(), settings: snapshot,
      payload: { text, attachments, isCommand: text.startsWith("/") }, sessionId: null, state: "persisted", error: null };
    await putOutboxRecord(record);
    // Never erase a newer draft or one belonging to a different visible session.
    if (epoch === chat.epoch && origin === serverUrl.value && credential === token.value) {
      // Appended typing is the next draft. Arbitrary replacement/editing is left intact.
      if (composer.text.startsWith(originalText)) composer.text = composer.text.slice(originalText.length);
      composer.attachments = composer.attachments.filter(attachment => !attachmentList.includes(attachment));
      saveDraft();
      for (const a of attachmentList) if (a.url) URL.revokeObjectURL(a.url);
    }
    if (origin === serverUrl.value && credential === token.value) {
      display(record);
      void transmit(record.id).catch(error => {
        const item = backgroundSends.find(row => row.id === record.id);
        if (item) { item.busy = false; item.status = "error"; item.message = (error as Error).message; }
      });
    }
    return true;
  } finally { composer.capturingBackground = false; }
}

async function transmit(id: string): Promise<void> {
  if (active.has(id)) return;
  active.add(id);
  let record: Record | null = null;
  const generation = scopeGeneration, origin = serverUrl.value, credential = token.value;
  const fence = () => {
    if (generation !== scopeGeneration || origin !== serverUrl.value || credential !== token.value)
      throw new Error("Connection changed. Switch back to recover this send.");
  };
  const save = async () => {
    if (!record) return;
    record.updatedAt = Date.now();
    if (!await saveClaimedRecord(record, clientId)) throw new Error("Send recovery is busy in another tab. Retry shortly.");
    fence(); display(record);
  };
  try {
    record = await claimOutboxRecord(id, clientId);
    if (!record) throw new Error("Send recovery is busy in another tab. Retry shortly.");
    if (record.scope !== await currentScope()) throw new Error("Switch back to the original connection to retry.");
    fence(); display(record);
    if (record.state === "accepted") return;
    if (!record.sessionId) {
      record.state = "creating_session"; await save();
      const found = await lookup<{ id: number }>(creationPath(record)); fence();
      if (found) record.sessionId = String(found.id);
      else {
        const { thinking, ...settings } = record.settings;
        const created = await json<{ id: number }>("/v1/sessions", { method: "POST",
          body: JSON.stringify({ ...settings, thinkingLevel: thinking, requestId: record.creationRequestId }) });
        fence(); record.sessionId = String(created.id);
      }
      record.state = "session_created"; await save();
      void loadSessions().catch(() => {});
    }
    if (!record.payload) { record.state = "accepted"; await save(); return; }
    if (await confirmReceipt(record)) { fence(); await save(); return; }
    fence(); record.state = "submitting"; await save();
    const isCommand = record.payload!.isCommand;
    const result = await json<{ notice?: string; submissionId?: number; command?: boolean }>(
      `/v1/sessions/${record.sessionId}/${isCommand ? "background-commands" : "messages?async=1"}`,
      { method: "POST", body: JSON.stringify({ content: content(record), requestId: record.messageRequestId }) });
    fence();
    record.notice = result.notice; record.state = "accepted"; record.error = null; record.payload = null;
    await save();
  } catch (error) {
    if (record) {
      record.state = "failed"; record.error = (error as Error).message;
      // Preserve recovery for the old scope, but do not expose it under a new connection.
      await saveClaimedRecord(record, clientId);
      if (generation === scopeGeneration && origin === serverUrl.value && credential === token.value) display(record, true);
    } else throw error;
  } finally {
    active.delete(id);
    if (record) {
      await releaseOutboxClaim(id, clientId);
      if (generation === scopeGeneration && origin === serverUrl.value && credential === token.value) display(record, true);
      void loadSessions().catch(() => {});
    }
  }
}

// Reconciliation issues GETs only. Local record updates never cause automatic network writes.
export async function initializeBackgroundSends(): Promise<void> {
  const generation = ++scopeGeneration;
  for (const timer of successTimers.values()) clearTimeout(timer);
  successTimers.clear();
  backgroundSends.splice(0);
  const scope = await currentScope();
  const records = await listOutboxRecords(scope);
  for (const r of records) {
    if (generation !== scopeGeneration) return;
    if (active.has(r.id)) { display(r); continue; }
    // Do not overwrite an active sender in another tab with a stale snapshot.
    const held = (r.claimedUntil ?? 0) > Date.now();
    if (r.state !== "accepted" && !held) {
      let confirmed = false;
      try {
        if (!r.sessionId) { const found = await lookup<{ id: number }>(creationPath(r)); if (found) r.sessionId = String(found.id); }
        if (generation !== scopeGeneration) return;
        confirmed = await confirmReceipt(r);
      } catch (error) { r.error = (error as Error).message; }
      if (generation !== scopeGeneration) return;
      if (!confirmed) { r.state = "failed"; r.error ??= "Delivery unconfirmed. Retry to continue."; }
      // A claim also fences reconciliation against a newly started sender.
      const claimed = await claimOutboxRecord(r.id, clientId);
      if (claimed) {
        try { if (claimed.updatedAt === r.updatedAt) await saveClaimedRecord(r, clientId); }
        finally { await releaseOutboxClaim(r.id, clientId); }
      }
    }
    if (generation !== scopeGeneration) return;
    display(r, true);
  }
}
export async function retryBackgroundSend(id: string): Promise<void> {
  const record = await getOutboxRecord(id);
  if (!record || record.scope !== await currentScope()) return;
  await transmit(id);
}
export async function dismissBackgroundSend(id: string): Promise<void> {
  const record = await getOutboxRecord(id);
  if (!record || record.scope !== await currentScope()) return;
  if (active.has(id) || (record.claimedUntil ?? 0) > Date.now()) throw new Error("Wait for this send to finish before dismissing recovery.");
  await deleteOutboxRecord(id);
  const index = backgroundSends.findIndex(r => r.id === id);
  if (index >= 0) backgroundSends.splice(index, 1);
}
watch([serverUrl, token], () => { void initializeBackgroundSends().catch(() => {}); });
