// Open conversation: durable entries, live generation, tools, extras, context, run controls.
// Port of vanilla session.js + extras.js + transcript.js state. Components only render this.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { computed, markRaw, reactive } from "vue";
import { api, json, post } from "@/lib/api";
import { watchFeed, type Feed } from "@/lib/sync";
import { savedSession, rememberSession, routeSession, sessionPane, notifySessionPanes } from "@/lib/pane";
import { focusInput, leavePages } from "./app";
import { composer, restoreDraft, saveDraft } from "./composer";
import { models, setSelectedModel } from "./models";
import { history, loadSessions, resetHistoryView } from "./sessions";

export interface Notice { id: number; text: string; kind: "err" | "muted"; scope: "session" | "run" }
export interface SideMedia { directive: string; name: string; url: string; type: string }
export interface SideJob { id: string; kind: string; status: string; prompt: string; text?: string; media?: SideMedia[]; createdAt: number }
export interface ContextValue {
  contextWindow?: number; percent?: number; usedTokens: number; triggerPercent?: number;
  autoCompactionEnabled?: boolean; compacting?: boolean;
}
export interface ProcessRow { id: string; running: boolean; status: string; command: string; createdAt: number; finishedAt?: number; exitCode: number | null; error?: string }
export interface ChildRow { id: number; task: string; status: string; statusReason?: string | null }
export interface Extras { goal?: any; todos?: any[]; questions: any[]; processes: ProcessRow[]; children: ChildRow[] }
const LIVE_CHILD = new Set(["running", "needs_input", "needs_approval"]);
export const childLive = (c: ChildRow) => LIVE_CHILD.has(c.status);

export const EXTRA_TOOLS = /^(todo|ask_user_question|create_goal|update_goal|set_goal_tasks|update_goal_task)$/;

export function textBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  return ((content as any[]) || []).filter(c => c.type === "text").map(c => c.text).join("");
}

export const chat = reactive({
  session: savedSession(),
  title: "New conversation",
  project: null as number | null,
  /** Bumps on every conversation switch; async work from older views is dropped. */
  epoch: 0,
  /** Bumps when durable entries change. */
  rev: 0,
  connected: false,
  runActive: false,
  generationActive: false,
  queuedCount: 0,
  /** Text of the in-flight assistant message (rAF-throttled). */
  liveText: "",
  liveThinking: "",
  /** Live tool output by call id; replaces the static view while the tool runs. */
  toolLive: {} as Record<string, string>,
  /** Tools reported by the feed that may not be in durable entries yet. */
  toolStarts: {} as Record<string, { name: string; args?: unknown; timestamp?: number; taskId?: string }>,
  toolResults: {} as Record<string, any>,
  activeTools: new Set<string>(),
  compactions: new Set<string>(),
  contextCompacting: false,
  /** undefined: hidden; null: unavailable; value: estimate. */
  context: undefined as ContextValue | null | undefined,
  usage: null as any,
  notices: [] as Notice[],
  sideJobs: new Map<string, SideJob>(),
  /** Resolved authenticated media: blob URL or error text. */
  media: {} as Record<string, { url?: string; size?: number; error?: string }>,
  extras: null as Extras | null,
  busyFeedback: "",
  /** Bumps when the transcript must scroll to the bottom regardless of position. */
  followTick: 0,
  booting: false,
  bootError: "",
});

/** Durable entries live outside deep reactivity (they can be large). Read via `entryList`. */
let entries = new Map<number, any>();
export const entryList = computed(() => { void chat.rev; return [...entries.values()].sort((a, b) => a.id - b.id); });

let noticeId = 0;
export function addErr(text: string, kind: Notice["kind"] = "err", scope: Notice["scope"] = "session") { chat.notices.push({ id: ++noticeId, text, kind, scope }); }
export function dismissNotice(id: number) { chat.notices = chat.notices.filter(notice => notice.id !== id); }
function clearRunNotices() { chat.notices = chat.notices.filter(notice => notice.scope !== "run"); }

// ---- run controls / status ----
export const sending = computed(() => !!chat.session && composer.submitting.has(chat.session));
export const busy = computed(() => chat.runActive || chat.generationActive || chat.activeTools.size > 0 || chat.queuedCount > 0 || chat.contextCompacting || chat.compactions.size > 0);
export const sendDisabled = computed(() => sending.value || (!!chat.session && !chat.connected));
export const stopDisabled = computed(() => !busy.value || !chat.connected);
function toolName(id: string): string | undefined {
  if (chat.toolStarts[id]) return chat.toolStarts[id].name;
  void chat.rev;
  for (const e of entries.values()) for (const c of e.model?.[0]?.content || []) if (c.type === "toolCall" && c.id === id) return c.name;
  return undefined;
}
export const status = computed(() => {
  if (chat.bootError) return chat.bootError;
  const waiting = [...chat.activeTools].some(id => toolName(id) === "ask_user_question");
  return sending.value ? "Sending…" : chat.session && !chat.connected ? "Reconnecting…" : chat.contextCompacting || chat.compactions.size > 0 ? "Compacting context…" : waiting ? "Waiting for your answer…"
    : chat.queuedCount ? `Running · ${chat.queuedCount} queued` : busy.value ? (chat.liveText ? "Writing…" : "Running…") : "Ready";
});
export const activityLabel = computed(() => {
  if (chat.bootError) return chat.bootError;
  if (sending.value) return "Sending…";
  if (chat.session && !chat.connected) return "Reconnecting…";
  if (chat.contextCompacting || chat.compactions.size) return "Compacting context…";
  if ([...chat.activeTools].some(id => toolName(id) === "ask_user_question")) return "Waiting for your answer…";
  if (chat.queuedCount) return `Running · ${chat.queuedCount} queued`;
  if (chat.activeTools.size) return "Running…";
  if (chat.liveText) return "Writing…";
  if (chat.generationActive) return "Thinking…";
  return chat.runActive ? "Running…" : "";
});
export const usageText = computed(() => {
  const u = chat.usage;
  if (!u?.models) return "";
  let inT = 0, outT = 0, cost = 0;
  for (const v of Object.values(u.models) as any[]) { inT += v.input + (v.cacheRead || 0) + (v.cacheWrite || 0); outT += v.output; cost += v.cost?.total || 0; }
  return `${(inT / 1000).toFixed(1)}k in · ${(outT / 1000).toFixed(1)}k out${cost ? " · $" + cost.toFixed(4) : ""}`;
});

// ---- context estimate ----
export const contextView = computed(() => {
  const value = chat.context;
  if (value === undefined) return null;
  if (value === null) return { level: "unknown", known: false, percent: 0, text: "Context usage unavailable", title: "", valueText: "", unavailable: true };
  const known = Number.isFinite(value.contextWindow) && value.contextWindow! > 0 && Number.isFinite(value.percent);
  const percent = known ? value.percent! : 0;
  const level = known ? (percent >= (value.triggerPercent ?? Infinity) ? "red" : percent >= 50 ? "amber" : "green") : "unknown";
  const tokens = Math.round(value.usedTokens).toLocaleString();
  const clamped = Math.max(0, Math.min(100, percent));
  return {
    level, known, percent: clamped, unavailable: false,
    text: known ? `Context ≈${tokens} / ${value.contextWindow!.toLocaleString()} · ${percent.toFixed(1)}%` : `Context ≈${tokens} tokens · capacity unavailable`,
    valueText: known ? percent.toFixed(1) + "% of model context, estimated" : "",
    title: `Estimated active context. Automatic compaction ${value.autoCompactionEnabled ? "at " + value.triggerPercent + "%" : "disabled"}.`,
  };
});
let contextTimer: ReturnType<typeof setTimeout> | undefined, contextRevision = 0;
function showContext(value: ContextValue | null | undefined) {
  chat.context = value || undefined;
  if (value) chat.contextCompacting = !!value.compacting;
}
export function scheduleContext() {
  clearTimeout(contextTimer);
  const sid = chat.session, epoch = chat.epoch, revision = ++contextRevision;
  if (!sid) return;
  contextTimer = setTimeout(async () => {
    try {
      const value = await json<ContextValue>(`/v1/sessions/${sid}/context`);
      if (sid === chat.session && epoch === chat.epoch && revision === contextRevision) showContext(value);
    } catch {
      if (sid === chat.session && epoch === chat.epoch && revision === contextRevision) chat.context = null;
    }
  }, 80);
}

// ---- extras: todos, open questions, goal ----
let extrasTimer: ReturnType<typeof setTimeout> | undefined;
const answering = new Set<string>();
async function loadExtras(retries: number, sid: string | null, epoch: number) {
  if (!sid || epoch !== chat.epoch) return;
  const s = await json(`/v1/sessions/${sid}?limit=1`).catch(() => null);
  if (!s || sid !== chat.session || epoch !== chat.epoch) return;
  setExtras(s);
  if (retries && !s.questions.length) extrasTimer = setTimeout(() => loadExtras(retries - 1, sid, epoch), 500);
}
// Processes and subagents change outside this conversation's event feed. Poll only while one is live.
let activityTimer: ReturnType<typeof setTimeout> | undefined;
function setExtras(s: any) {
  chat.extras = markRaw({ goal: s.goal, todos: s.todos || [], questions: s.questions || [], processes: s.processes || [], children: s.children || [] });
  clearTimeout(activityTimer);
  if (chat.extras.processes.some(p => p.running) || chat.extras.children.some(childLive)) {
    const sid = chat.session, epoch = chat.epoch;
    activityTimer = setTimeout(() => loadExtras(0, sid, epoch), 3000);
  }
}
export const cancelExtras = () => { clearTimeout(extrasTimer); clearTimeout(activityTimer); };
export function scheduleExtras(retries = 0) {
  clearTimeout(extrasTimer);
  const sid = chat.session, epoch = chat.epoch;
  extrasTimer = setTimeout(() => loadExtras(retries, sid, epoch), 80);
}
export async function stopProcess(id: string) {
  const sid = chat.session, epoch = chat.epoch;
  try { await post(`/v1/sessions/${sid}/processes/${encodeURIComponent(id)}/stop`); if (epoch === chat.epoch) scheduleExtras(); }
  catch (e) { if (epoch === chat.epoch) addErr((e as Error).message); }
}
export async function stopChild(id: number) {
  const epoch = chat.epoch;
  try { await post(`/v1/sessions/${id}/abort`); if (epoch === chat.epoch) scheduleExtras(); }
  catch (e) { if (epoch === chat.epoch) addErr((e as Error).message); }
}
export async function goalAction(action: "pause" | "resume" | "clear") {
  const sid = chat.session, epoch = chat.epoch;
  if (action === "clear" && !confirm("Clear this goal?")) return;
  try { await post(`/v1/sessions/${sid}/goal`, { action }, "PATCH"); if (epoch === chat.epoch) scheduleExtras(); }
  catch (e) { if (epoch === chat.epoch) addErr((e as Error).message); }
}
/** Returns true when the answer was accepted (the form can go away). */
export async function answerQuestion(callId: string, body: unknown): Promise<boolean> {
  const sid = chat.session, epoch = chat.epoch;
  if (answering.has(callId)) return false;
  answering.add(callId);
  try {
    await post(`/v1/sessions/${sid}/questions/${encodeURIComponent(callId)}`, body);
    if (chat.extras && epoch === chat.epoch) chat.extras = markRaw({ ...chat.extras, questions: chat.extras.questions.filter(q => q.callId !== callId) });
    return true;
  } catch (e) { if (epoch === chat.epoch) addErr((e as Error).message); return false; }
  finally { answering.delete(callId); }
}

// ---- side jobs (transport state, never model-visible) ----
const mediaRequests = new Map<string, Promise<{ url: string; size: number }>>();
/** Fetch authenticated media once per URL into a blob URL (chat.media), or record why it failed. */
export function loadMedia(url: string) {
  if (mediaRequests.has(url)) return;
  const epoch = chat.epoch;
  const p = api(url).then(async r => {
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    const blob = await r.blob();
    return { url: URL.createObjectURL(blob), size: blob.size };
  });
  mediaRequests.set(url, p);
  p.then(m => { if (epoch === chat.epoch) chat.media[url] = m; else URL.revokeObjectURL(m.url); })
    .catch(e => { if (epoch === chat.epoch) chat.media[url] = { error: (e as Error).message }; });
}
function trackMedia(job: SideJob) { for (const m of job.media || []) loadMedia(m.url); }
export function putSideJob(job: SideJob) { chat.sideJobs.set(job.id, markRaw(job)); trackMedia(job); }
function setSideJobs(jobs: SideJob[] | undefined) { chat.sideJobs.clear(); for (const j of jobs || []) putSideJob(j); }
function clearSideJobs() {
  chat.sideJobs.clear();
  for (const p of mediaRequests.values()) p.then(m => URL.revokeObjectURL(m.url)).catch(() => {});
  mediaRequests.clear(); chat.media = {};
}

// ---- feeds ----
let activeFeed: Feed | null = null, listFeed: Feed | null = null;
let liveMessage: any = null, liveFrame: number | null = null;

function detachView() {
  chat.busyFeedback = "";
  clearSideJobs();
  chat.epoch++; activeFeed?.stop(); activeFeed = null;
  cancelExtras(); clearTimeout(contextTimer); contextRevision++;
  chat.contextCompacting = false; chat.compactions = new Set(); chat.context = undefined;
  if (liveFrame !== null) cancelAnimationFrame(liveFrame); liveFrame = null;
  chat.connected = false; chat.runActive = chat.generationActive = false; chat.queuedCount = 0;
  liveMessage = null; chat.liveText = ""; chat.liveThinking = ""; entries = new Map(); chat.rev++;
  chat.project = null;
  chat.toolLive = {}; chat.toolStarts = {}; chat.toolResults = {}; chat.activeTools = new Set();
  chat.notices = []; chat.extras = null;
}
function setSession(id: string | null) {
  chat.session = id;
  rememberSession(id);
}
export function clearConversation() {
  saveDraft(); detachView(); setSession(null);
  chat.title = "New conversation";
  setSelectedModel(models.defaultModel); models.thinking = "off"; chat.usage = null;
  restoreDraft();
}
function applyAgent(agent: any) {
  setSelectedModel(agent?.model || models.defaultModel); models.thinking = agent?.thinkingLevel || "off";
}
function syncLive() {
  chat.liveText = textBlocks(liveMessage?.content);
  chat.liveThinking = Array.isArray(liveMessage?.content) ? liveMessage.content.filter((b: any) => b.type === "thinking").map((b: any) => b.thinking || "").join("\n\n") : "";
}
function queueLive(epoch: number) {
  if (liveFrame !== null) return;
  liveFrame = requestAnimationFrame(() => { liveFrame = null; if (epoch === chat.epoch) syncLive(); });
}
function putEntry(entry: any) { entries.set(entry.id, markRaw(entry)); chat.rev++; }

function onSessionEvent(type: string, e: any, epoch: number) {
  if (epoch !== chat.epoch) return;
  if (type === "side_jobs") { setSideJobs(e.jobs); return; }
  if (type === "side_job") { putSideJob(e); return; }
  if (type === "snapshot") {
    chat.connected = true;
    for (const entry of e.entries || []) entries.set(entry.id, markRaw(entry));
    chat.rev++;
    chat.runActive = !!e.run; chat.generationActive = !!e.generation; chat.queuedCount = e.inbox?.length || 0;
    chat.compactions = new Set((e.compactions || []).map((c: any) => c.taskId));
    chat.contextCompacting = chat.compactions.size > 0; scheduleContext();
    const slots = [...(e.tools || []), ...(e.nestedTools || [])];
    chat.activeTools = new Set(slots.filter(t => t.status !== "done").map(t => t.callId));
    liveMessage = e.generation?.message ? structuredClone(e.generation.message) : null; syncLive();
    applyAgent(e.agent || {}); chat.usage = e.usage ? markRaw(e.usage) : null;
    for (const slot of slots) {
      if (slot.status === "done" && !slot.parentCallId) continue;
      if (!chat.toolStarts[slot.callId]) chat.toolStarts[slot.callId] = { name: slot.name, args: slot.arguments, taskId: slot.taskId };
      if (slot.output) chat.toolLive[slot.callId] = slot.output;
      if (slot.status === "done" && slot.summary) {
        chat.toolResults[slot.callId] = { isError: slot.summary.isError, content: slot.summary.error || slot.output || "" };
      }
    }
    scheduleExtras();
  } else if (type === "message_start" && e.message.role === "assistant") {
    chat.generationActive = true; liveMessage = structuredClone(e.message); queueLive(epoch);
  } else if (type === "message_update") {
    chat.generationActive = true;
    liveMessage ||= { role: "assistant", content: [] };
    for (const change of e.changes || []) {
      if (change.type === "message") liveMessage = structuredClone(change.message);
      else if (change.type.endsWith("_start") || change.type === "block") liveMessage.content[change.contentIndex] = structuredClone(change.block);
      else if (change.type === "text_delta" || change.type === "thinking_delta") {
        const field = change.type === "text_delta" ? "text" : "thinking";
        const block = liveMessage.content[change.contentIndex] ||= { type: field === "text" ? "text" : "thinking", [field]: "" };
        block[field] = (block[field] || "") + change.delta;
      }
    }
    queueLive(epoch);
  } else if (type === "message_end" || type === "entry_appended") {
    if (e.entry.model?.[0]?.role === "assistant") { liveMessage = null; syncLive(); }
    putEntry(e.entry); scheduleExtras(); scheduleContext();
  } else if (type === "run_start") { clearRunNotices(); chat.runActive = true; }
  else if (type === "run_end") {
    chat.runActive = chat.generationActive = false; chat.activeTools = new Set(); liveMessage = null; syncLive();
    scheduleExtras(); scheduleContext();
  }
  else if (type === "turn_start") { clearRunNotices(); chat.generationActive = true; }
  else if (type === "turn_end") chat.generationActive = false;
  else if (type === "inbox_update") chat.queuedCount = e.items.length;
  else if (type === "agent_changed") { applyAgent(e.agent); scheduleContext(); }
  else if (type === "usage_changed") { chat.usage = e.usage ? markRaw(e.usage) : null; scheduleContext(); }
  else if (type === "compaction_start") { chat.compactions.add(e.taskId); chat.contextCompacting = true; scheduleContext(); }
  else if (type === "compaction_end") {
    chat.compactions.delete(e.taskId); chat.contextCompacting = chat.compactions.size > 0;
    if (e.error) addErr("Context compaction failed: " + e.error);
    scheduleContext();
  }
  else if (type === "tool_execution_start") {
    chat.activeTools.add(e.toolCallId);
    if (!chat.toolStarts[e.toolCallId]) chat.toolStarts[e.toolCallId] = { name: e.toolName, args: e.args, timestamp: Date.now(), taskId: e.taskId };
    if (EXTRA_TOOLS.test(e.toolName)) scheduleExtras(e.toolName === "ask_user_question" ? 3 : 0);
  } else if (type === "tool_execution_update" && e.output) {
    const id = e.toolCallId;
    if ("set" in e.output) chat.toolLive[id] = e.output.set;
    else chat.toolLive[id] = (chat.toolLive[id] ?? toolArgsText(chat.toolStarts[id]?.args)).slice(e.output.trimStart || 0) + (e.output.append || "");
  } else if (type === "tool_execution_end") {
    chat.activeTools.delete(e.toolCallId);
    if (e.entry) putEntry(e.entry);
    if (e.result) {
      const output = e.result.structuredOutput;
      const content = typeof output === "string" ? output : Array.isArray(output) ? output : output !== undefined ? JSON.stringify(output, null, 2) : (e.result.diagnostics || []).map((d: any) => d.message || "").join("\n");
      chat.toolResults[e.toolCallId] = { ...e.result, content, timestamp: Date.now() };
    }
    scheduleExtras(); scheduleContext();
  }
  else if (type === "task_failed") {
    const call = Object.entries(chat.toolStarts).find(([, tool]) => tool.taskId === e.taskId)?.[0];
    if (call) {
      chat.activeTools.delete(call);
      chat.toolResults[call] = { isError: true, content: e.message, timestamp: Date.now() };
    } else addErr(e.message, "err", "run");
  }
  else if (type === "submission") {
    if (e.record.status === "unanswered") addErr(e.record.reason + (e.record.detail ? ": " + (typeof e.record.detail === "string" ? e.record.detail : JSON.stringify(e.record.detail)) : ""), "err", "run");
    scheduleExtras();
  }
}
export const toolArgsText = (args: unknown) => (args ? "args: " + JSON.stringify(args, null, 1) + "\n" : "");

export async function openSession(id: string | number) {
  if (!leavePages() || routeSession(String(id))) return;
  saveDraft(); detachView();
  setSession(String(id));
  const sid = chat.session!, epoch = chat.epoch;
  chat.title = history.list.find(s => String(s.id) === sid)?.title || "Conversation " + sid;
  restoreDraft();
  // Hydrate durable history on EVERY attachment. Its subsequent atomic snapshot closes the fetch/subscribe gap.
  activeFeed = watchFeed({
    path: `/v1/sessions/${sid}/events`, api,
    beforeConnect: async signal => {
      const s = await json(`/v1/sessions/${sid}?limit=500`, { signal });
      if (epoch !== chat.epoch) return;
      entries = new Map(s.entries.map((e: any) => [e.id, markRaw(e)])); chat.rev++;
      chat.project = s.project ?? history.list.find(row => String(row.id) === sid)?.project ?? null;
      applyAgent(s.agent); chat.usage = s.usage ? markRaw(s.usage) : null; showContext(s.contextUsage); setExtras(s);
      chat.followTick++;
    },
    onEvent: (type, e) => onSessionEvent(type, e, epoch),
    onDisconnect: error => {
      if (epoch !== chat.epoch) return false;
      if (error.status === 404) { clearConversation(); loadSessions().catch(() => {}); return false; }
      chat.connected = false; return error.message !== "unauthorized";
    },
  });
}
export async function newSession(project?: number | string | null): Promise<string | undefined> {
  if (!leavePages()) return;
  const epoch = chat.epoch;
  const body = project ? { project: Number(project) } : {};
  const { id } = await post<{ id: number | string }>("/v1/sessions", body);
  if (epoch !== chat.epoch) return String(id);
  resetHistoryView();
  await openSession(id); loadSessions().catch(() => {});
  return String(id);
}
export async function stopRun() {
  const sid = chat.session, epoch = chat.epoch;
  if (!sid) return;
  try { await post(`/v1/sessions/${sid}/abort`); }
  catch (e) { if (epoch === chat.epoch) addErr((e as Error).message); }
}
/** Starts a new conversation and leaves a Cron report in the composer. Never submits it. */
export async function continueCronRun(run: any) {
  const id = await newSession();
  if (id === undefined || String(id) !== chat.session) throw new Error("Conversation changed. Open the report again to continue.");
  composer.text = `Discuss this Cron report.\nJob: ${run.jobName}\nRun: #${run.id}\nFinished: ${new Date(run.endedAt || run.startedAt).toISOString()}\nStatus: ${run.status}\n\n${[run.output, run.error ? "Error: " + run.error : null].filter(Boolean).join("\n\n") || "(No output)"}\n\n`;
  saveDraft(); focusInput.value++;
}

export function stopFeeds() { activeFeed?.stop(); listFeed?.stop(); }
// A running session emits sessions_changed for every committed entry. Keep one list request in flight and
// fold any events that arrive meanwhile into a single trailing reload.
let listLoading: Promise<void> | undefined, listAgain = false;
function reloadList(): Promise<void> {
  if (listLoading) { listAgain = true; return listLoading; }
  listLoading = loadSessions().catch(() => {}).finally(() => {
    listLoading = undefined;
    if (listAgain) { listAgain = false; void reloadList(); }
  });
  return listLoading;
}
export function startListFeed() {
  if (sessionPane) return; // The workspace shares list notifications; each tile keeps its own session feed.
  listFeed?.stop();
  listFeed = watchFeed({
    path: "/v1/events", api,
    onEvent: async type => {
      if (type === "sessions_changed") { void reloadList(); notifySessionPanes(type); return; }
      if (type === "board_changed") { notifySessionPanes(type); const { boardChanged } = await import("./app"); boardChanged.value++; }
    },
    onDisconnect: e => e.message !== "unauthorized",
  });
}
window.addEventListener("message", async event => {
  if (!sessionPane || event.origin !== location.origin || event.source !== window.parent || event.data?.type !== "luna:workspace-event") return;
  if (event.data.event === "sessions_changed") void reloadList();
  if (event.data.event === "board_changed") { const { boardChanged } = await import("./app"); boardChanged.value++; }
});
function reconnectFeeds() { activeFeed?.reconnect(); listFeed?.reconnect(); }
window.addEventListener("online", reconnectFeeds);
document.addEventListener("visibilitychange", () => { if (!document.hidden) reconnectFeeds(); });
window.addEventListener("pagehide", () => { saveDraft(); activeFeed?.stop(); listFeed?.stop(); cancelExtras(); if (liveFrame !== null) cancelAnimationFrame(liveFrame); });
window.addEventListener("pageshow", e => { if (e.persisted) { startListFeed(); if (chat.session) void openSession(chat.session); } });
