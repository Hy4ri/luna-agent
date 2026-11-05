import { compactNumber } from "@/lib/numbers";
// Open conversation: durable entries, live generation, tools, extras, context, run controls.
// Port of vanilla session.js + extras.js + transcript.js state. Components only render this.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { computed, markRaw, reactive } from "vue";
import type { Machine } from "./workers";
import { api, json, post } from "@/lib/api";
import { watchFeed, type Feed } from "@/lib/sync";
import { savedSession, rememberSession, routeSession, sessionPane, notifySessionPanes } from "@/lib/pane";
import { boardChanged, focusInput, leavePages } from "./app";
import { composer, pendingMessages, restoreDraft, saveDraft, reconcileSubmission, retirePendingEntries, refreshPending } from "./composer";
import { models, setSelectedModel } from "./models";
import { history, loadSessions, loadFocusedSession, resetHistoryView } from "./sessions";

export interface Notice { id: number; text: string; kind: "err" | "muted"; scope: "session" | "run" }
export interface SideMedia { directive: string; name: string; url: string; type: string }
export interface SideJob { id: string; kind: string; status: string; prompt: string; text?: string; media?: SideMedia[]; createdAt: number; activity?: { kind: "status" | "message" | "tool"; text: string; result?: string; isError?: boolean }[] }
export interface ContextValue {
  contextWindow?: number; percent?: number; usedTokens: number;
  compacting?: boolean;
}
export interface ProcessRow { id: string; running: boolean; status: string; command: string; createdAt: number; finishedAt?: number; exitCode: number | null; error?: string }
export interface ChildRow { id: number; task: string; status: string; statusReason?: string | null; profile?: string | null; cwd?: string | null; resultStatus?: "valid" | "missing" | "not_requested" }
export interface DelegateUsage { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; costUsd: number; missingCost: boolean; zeroCostModels: string[]; costReported?: boolean | null }
export interface DelegationUsage { parent: DelegateUsage; childTotal: DelegateUsage; total: DelegateUsage; unavailableChildren: number; note: string }
export interface Extras { goal?: any; todos?: any[]; questions: any[]; processes: ProcessRow[]; children: ChildRow[]; delegationUsage?: DelegationUsage | null }
const LIVE_CHILD = new Set(["running", "needs_input", "needs_approval"]);
export const childLive = (c: ChildRow) => LIVE_CHILD.has(c.status);

const CHILD_RANK: Record<string, number> = { running: 0, needs_input: 1, needs_approval: 2 };
const childRank = (c: { status: string }) => CHILD_RANK[c.status] ?? 3;

/** Stable sort: running first, then needs_input/needs_approval, then all others. */
export function sortChildren<T extends { status: string }>(list: T[]): T[] {
  return list.slice().sort((a, b) => childRank(a) - childRank(b));
}

/** Stable sort: running === true first, then all others. */
export function sortProcesses<T extends { running: boolean }>(list: T[]): T[] {
  return list.slice().sort((a, b) => (a.running === b.running ? 0 : a.running ? -1 : 1));
}

const EXTRA_TOOLS = /^(todo|ask_user_question|create_goal|update_goal|set_goal_tasks|update_goal_task)$/;

function textBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  return ((content as any[]) || []).filter(c => c.type === "text").map(c => c.text).join("");
}

export const chat = reactive({
  session: savedSession(),
  // True while an empty new conversation occupies the primary tile (no server session yet).
  draftOpen: false,
  title: "New conversation",
  project: null as number | null,
  machine: null as Machine | null,
  cwd: null as string | null,
  draftWorker: null as number | null,
  draftCwd: "",
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
  toolStarts: {} as Record<string, { name: string; args?: unknown; timestamp?: number; taskId?: string; parentCallId?: string }>,
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
  hasMoreEntries: false,
  olderCursor: null as number | null,
  loadingOlder: false,
});

/** Durable entries live outside deep reactivity (they can be large). Read via `entryList`. */
let entries = new Map<number, any>();
export const entryList = computed(() => { void chat.rev; return [...entries.values()].sort((a, b) => a.id - b.id); });

let noticeId = 0;
export function addErr(text: string, kind: Notice["kind"] = "err", scope: Notice["scope"] = "session") { chat.notices.push({ id: ++noticeId, text, kind, scope }); }
export function dismissNotice(id: number) { chat.notices = chat.notices.filter(notice => notice.id !== id); }
function clearRunNotices() { chat.notices = chat.notices.filter(notice => notice.scope !== "run"); }

// ---- run controls / status ----
export const sending = computed(() => chat.session ? composer.submitting.has(chat.session) :
  [...pendingMessages.values()].some(p => p.session === null && p.epoch === chat.epoch && p.status === "Sending…"));
export const busy = computed(() => chat.runActive || chat.generationActive || chat.activeTools.size > 0 || chat.queuedCount > 0 || chat.contextCompacting || chat.compactions.size > 0);
export const sendDisabled = computed(() => chat.booting || !!chat.bootError || sending.value || (!!chat.session && !chat.connected));
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
  if (chat.liveText) return "Writing…";
  if (chat.generationActive) return "Thinking…";
  return chat.runActive ? "Running…" : "";
});
/** Derived from the same live slots and task document as the transcript; no generated progress. */
export const activityDetails = computed(() => {
  if (!busy.value || !chat.connected || chat.bootError) return [];
  const details: string[] = [];
  const tasks = (chat.extras?.todos || []).filter(t => t.status !== "deleted");
  if (tasks.length) {
    const completed = tasks.filter(t => t.status === "completed").length;
    const active = tasks.filter(t => t.status === "in_progress").map(t => t.activeForm || t.subject);
    details.push([`${completed}/${tasks.length} tasks complete`, ...active].join(" · "));
  }
  return details;
});
export const usageText = computed(() => {
  const u = chat.usage;
  if (!u?.models) return "";
  let inT = 0, outT = 0, cost = 0;
  for (const v of Object.values(u.models) as any[]) { inT += v.input + (v.cacheRead || 0) + (v.cacheWrite || 0); outT += v.output; cost += v.cost?.total || 0; }
  return `${compactNumber(inT)} in · ${compactNumber(outT)} out${cost ? " · $" + cost.toFixed(4) : ""}`;
});

export const reviewJobs = computed(() => [...chat.sideJobs.values()].filter(j => j.kind === "review").sort((a, b) => b.createdAt - a.createdAt));
export const runningReviews = computed(() => reviewJobs.value.filter(j => j.status === "running").length);

// Tasks, processes, or subagents exist for this session.
export const activityVisible = computed(() =>
  (chat.extras?.todos || []).some((t: any) => t.status !== "deleted") || !!chat.extras?.processes?.length || !!chat.extras?.children?.length);

// ---- context estimate ----
export const contextView = computed(() => {
  const value = chat.context;
  if (value === undefined) return null;
  if (value === null) return { level: "unknown", known: false, percent: 0, text: "Context usage unavailable", title: "", valueText: "", unavailable: true };
  const known = Number.isFinite(value.contextWindow) && value.contextWindow! > 0 && Number.isFinite(value.percent);
  const percent = known ? value.percent! : 0;
  const level = known ? (percent >= 80 ? "red" : percent >= 50 ? "amber" : "green") : "unknown";
  const tokens = compactNumber(value.usedTokens);
  const clamped = Math.max(0, Math.min(100, percent));
  return {
    level, known, percent: clamped, unavailable: false,
    text: known ? `Context ≈${tokens} / ${compactNumber(value.contextWindow)} · ${percent.toFixed(1)}%` : `Context ≈${tokens} tokens · capacity unavailable`,
    valueText: known ? percent.toFixed(1) + "% of model context, estimated" : "",
    title: "Estimated active context. Older context is summarized automatically.",
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
  // One post-attachment read refreshes both custom documents and the context estimate.
  clearTimeout(contextTimer);
  const revision = ++contextRevision;
  const s = await json(`/v1/sessions/${sid}?view=ui&limit=1&context=1`).catch(() => null);
  if (sid !== chat.session || epoch !== chat.epoch) return;
  if (revision === contextRevision) {
    if (s) showContext(s.contextUsage);
    else chat.context = null;
  }
  if (!s) return;
  setExtras(s);
  if (retries && !s.questions.length) extrasTimer = setTimeout(() => loadExtras(retries - 1, sid, epoch), 500);
}
// Processes and subagents change outside this conversation's event feed. Poll only while one is live.
let activityTimer: ReturnType<typeof setTimeout> | undefined;
function setExtras(s: any) {
  chat.extras = markRaw({ goal: s.goal, todos: s.todos || [], questions: s.questions || [], processes: s.processes || [], children: s.children || [], delegationUsage: s.delegationUsage ?? null });
  clearTimeout(activityTimer);
  if (chat.extras.processes.some(p => p.running) || chat.extras.children.some(childLive)) {
    const sid = chat.session, epoch = chat.epoch;
    activityTimer = setTimeout(() => loadExtras(0, sid, epoch), 3000);
  }
}
const cancelExtras = () => { clearTimeout(extrasTimer); clearTimeout(activityTimer); };
function scheduleExtras(retries = 0) {
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
  chat.project = null; chat.machine = null; chat.cwd = null; chat.draftWorker = null; chat.draftCwd = "";
  chat.toolLive = {}; chat.toolStarts = {}; chat.toolResults = {}; chat.activeTools = new Set();
  chat.notices = []; chat.extras = null;
  chat.hasMoreEntries = false; chat.olderCursor = null; chat.loadingOlder = false;
}
function setSession(id: string | null) {
  chat.session = id;
  chat.draftOpen = false;
  rememberSession(id);
}
export function clearConversation() {
  saveDraft(); detachView(); setSession(null);
  chat.title = "New conversation";
  models.draft = {};
  setSelectedModel(models.defaultModel); models.thinking = "off"; chat.usage = null;
  restoreDraft();
}
function applyAgent(agent: any) {
  chat.cwd = agent?.cwd ?? null;
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
function retirePending() { if (chat.session && pendingMessages.size) retirePendingEntries(chat.session, new Set(entries.keys())); }
function putEntry(entry: any) { entries.set(entry.id, markRaw(entry)); chat.rev++; retirePending(); }

const sessionEventHandlers: Record<string, (e: any, epoch: number) => void> = {
  side_jobs(e) { setSideJobs(e.jobs); },
  side_job(e) { putSideJob(e); },
  snapshot(e, epoch) {
    chat.connected = true;
    for (const entry of e.entries || []) entries.set(entry.id, markRaw(entry));
    chat.rev++;
    const sid = chat.session;
    if (sid) void refreshPending(sid).then(() => { if (chat.session === sid && chat.epoch === epoch) retirePending(); });
    retirePending();
    chat.runActive = !!e.run; chat.generationActive = !!e.generation; chat.queuedCount = e.inbox?.length || 0;
    chat.compactions = new Set((e.compactions || []).map((c: any) => c.taskId));
    chat.contextCompacting = chat.compactions.size > 0;
    const slots = [...(e.tools || []), ...(e.nestedTools || [])];
    chat.activeTools = new Set(slots.filter(t => t.status !== "done").map(t => t.callId));
    liveMessage = e.generation?.message ? structuredClone(e.generation.message) : null; syncLive();
    applyAgent(e.agent || {}); chat.usage = e.usage ? markRaw(e.usage) : null;
    for (const slot of slots) {
      if (slot.status === "done" && !slot.parentCallId) continue;
      if (!chat.toolStarts[slot.callId]) chat.toolStarts[slot.callId] = { name: slot.name, args: slot.arguments, taskId: slot.taskId, ...(slot.parentCallId ? { parentCallId: slot.parentCallId } : {}) };
      if (slot.output) chat.toolLive[slot.callId] = slot.output;
      if (slot.status === "done" && slot.summary) {
        chat.toolResults[slot.callId] = { isError: slot.summary.isError, content: slot.summary.error || slot.output || "" };
      }
    }
    scheduleExtras();
  },
  message_start(e, epoch) {
    if (e.message.role === "assistant") {
      chat.generationActive = true; liveMessage = structuredClone(e.message); queueLive(epoch);
    }
  },
  message_update(e, epoch) {
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
  },
  message_end(e) {
    for (const record of e.submissions || []) reconcileSubmission(record);
    if (e.entry.model?.[0]?.role === "assistant") { liveMessage = null; syncLive(); }
    putEntry(e.entry); scheduleExtras(); scheduleContext();
  },
  entry_appended(e) {
    for (const record of e.submissions || []) reconcileSubmission(record);
    if (e.entry.model?.[0]?.role === "assistant") { liveMessage = null; syncLive(); }
    putEntry(e.entry); scheduleExtras(); scheduleContext();
  },
  run_start() { clearRunNotices(); chat.runActive = true; },
  run_end() {
    chat.runActive = chat.generationActive = false; chat.activeTools = new Set(); liveMessage = null; syncLive();
    scheduleExtras(); scheduleContext();
  },
  turn_start() { clearRunNotices(); chat.generationActive = true; },
  turn_end() { chat.generationActive = false; },
  inbox_update(e) { chat.queuedCount = e.items.length; },
  agent_changed(e) { applyAgent(e.agent); scheduleContext(); },
  usage_changed(e) { chat.usage = e.usage ? markRaw(e.usage) : null; scheduleContext(); },
  compaction_start(e) { chat.compactions.add(e.taskId); chat.contextCompacting = true; scheduleContext(); },
  compaction_end(e) {
    chat.compactions.delete(e.taskId); chat.contextCompacting = chat.compactions.size > 0;
    if (e.error) addErr("Context compaction failed: " + e.error);
    scheduleContext();
  },
  tool_execution_start(e) {
    chat.activeTools.add(e.toolCallId);
    if (!chat.toolStarts[e.toolCallId]) chat.toolStarts[e.toolCallId] = { name: e.toolName, args: e.args, timestamp: Date.now(), taskId: e.taskId, ...(e.parentToolCallId ? { parentCallId: e.parentToolCallId } : {}) };
    if (EXTRA_TOOLS.test(e.toolName)) scheduleExtras(e.toolName === "ask_user_question" ? 3 : 0);
  },
  tool_execution_update(e) {
    if (e.output) {
      const id = e.toolCallId;
      if ("set" in e.output) chat.toolLive[id] = e.output.set;
      else chat.toolLive[id] = (chat.toolLive[id] ?? toolArgsText(chat.toolStarts[id]?.args)).slice(e.output.trimStart || 0) + (e.output.append || "");
    }
  },
  tool_execution_end(e) {
    chat.activeTools.delete(e.toolCallId);
    if (e.entry) putEntry(e.entry);
    if (e.result) {
      const output = e.result.structuredOutput;
      const content = typeof output === "string" ? output : Array.isArray(output) ? output : output !== undefined ? JSON.stringify(output, null, 2) : (e.result.diagnostics || []).map((d: any) => d.message || "").join("\n");
      chat.toolResults[e.toolCallId] = { ...e.result, content, timestamp: Date.now(), ...(e.entry ? { entryId: e.entry.id } : {}) };
    }
    scheduleExtras(); scheduleContext();
  },
  task_failed(e) {
    const call = Object.entries(chat.toolStarts).find(([, tool]) => tool.taskId === e.taskId)?.[0];
    if (call) {
      chat.activeTools.delete(call);
      chat.toolResults[call] = { isError: true, content: e.message, timestamp: Date.now() };
    } else addErr(e.message, "err", "run");
  },
  submission(e) {
    reconcileSubmission(e.record); retirePending();
    if (e.record.status === "unanswered") addErr(e.record.reason + (e.record.detail ? ": " + (typeof e.record.detail === "string" ? e.record.detail : JSON.stringify(e.record.detail)) : ""), "err", "run");
    scheduleExtras();
  },
};

function onSessionEvent(type: string, e: any, epoch: number) {
  if (epoch !== chat.epoch) return;
  sessionEventHandlers[type]?.(e, epoch);
}
export const toolArgsText = (args: unknown) => (args ? "args: " + JSON.stringify(args, null, 1) + "\n" : "");

export async function openSession(id: string | number, reattach = false) {
  if (!reattach && (!leavePages() || routeSession(String(id)))) return;
  saveDraft(); detachView();
  setSession(String(id));
  const sid = chat.session!, epoch = chat.epoch;
  chat.title = history.list.find(s => String(s.id) === sid)?.title || "Conversation " + sid;
  void loadFocusedSession(sid);
  restoreDraft();
  let hydrated = false;
  let snapshotAfter: number | undefined;
  // Hydrate durable history on EVERY attachment. Its subsequent atomic snapshot closes the fetch/subscribe gap.
  activeFeed = watchFeed({
    path: () => `/v1/sessions/${sid}/events?view=ui${snapshotAfter !== undefined ? `&after=${snapshotAfter}` : ""}`,
    api,
    beforeConnect: async signal => {
      const s = await json(`/v1/sessions/${sid}?view=ui&limit=100`, { signal, timeoutMs: 30000 });
      if (epoch !== chat.epoch || signal.aborted) return;
      // The server returns append-only, fork-aware history. Keep the already loaded older rows.
      if (!hydrated) {
        entries = new Map();
        chat.hasMoreEntries = !!s.hasMore;
        chat.olderCursor = s.nextCursor ?? (s.hasMore && s.entries.length ? s.entries[s.entries.length - 1].id : null);
      }
      for (const e of s.entries) entries.set(e.id, markRaw(e));
      const entryIds = s.entries.map((e: any) => e.id);
      if (entryIds.length) {
        snapshotAfter = Math.max(...entryIds);
      }
      hydrated = true; chat.rev++;
      chat.project = s.project ?? history.list.find(row => String(row.id) === sid)?.project ?? null;
      chat.machine = s.machine ?? null;
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

/** Loads older entries using the cursor pagination contract. */
export async function loadOlderEntries() {
  const sid = chat.session, epoch = chat.epoch;
  if (!sid || chat.loadingOlder || !chat.hasMoreEntries) return;
  // Fall back to the lowest currently loaded entry id if olderCursor is not set
  let before = chat.olderCursor;
  if (before === null || before === undefined) {
    const minId = Math.min(...entries.keys());
    if (Number.isFinite(minId)) before = minId;
  }
  if (before === null || before === undefined) return;

  chat.loadingOlder = true;
  try {
    const s = await json<{ entries: any[]; hasMore?: boolean; nextCursor?: number | null }>(
      `/v1/sessions/${sid}?view=ui&limit=100&before=${before}`,
      { timeoutMs: 30000 },
    );
    if (chat.session !== sid || chat.epoch !== epoch) return;
    for (const e of s.entries || []) {
      entries.set(e.id, markRaw(e));
    }
    chat.hasMoreEntries = !!s.hasMore;
    chat.olderCursor = s.nextCursor ?? (s.hasMore && s.entries?.length ? s.entries[s.entries.length - 1].id : null);
    chat.rev++;
  } catch (err: any) {
    if (chat.session === sid && chat.epoch === epoch) {
      addErr("Failed to load older messages: " + (err.message || String(err)));
    }
  } finally {
    if (chat.session === sid && chat.epoch === epoch) {
      chat.loadingOlder = false;
    }
  }
}

/** Starts an empty, local-only conversation. The server session is created on the first message (see `createSession`). */
export async function newSession(project?: number | string | null, worker?: number | null): Promise<boolean> {
  if (!leavePages()) return false;
  clearConversation();
  chat.project = project !== undefined && project !== null ? Number(project) : null;
  const selectedProject = history.projects.find(p => p.id === chat.project);
  if (worker !== undefined) {
    chat.draftWorker = worker;
  } else if (selectedProject && !selectedProject.general && !selectedProject.cwd) {
    chat.draftWorker = selectedProject.workerDirs?.[0]?.worker ?? null;
  }
  chat.draftOpen = true;
  return true;
}
/** Creates the server session and opens it. Called when the first message is sent from an empty conversation. */
export async function createSession(project?: number | string | null): Promise<string | undefined> {
  if (!leavePages()) return;
  const epoch = chat.epoch;
  const body = { ...(project !== undefined && project !== null ? { project: Number(project) } : {}), ...models.draft, ...(chat.draftWorker !== null ? { worker: chat.draftWorker } : {}), ...(chat.draftCwd ? { cwd: chat.draftCwd } : {}) };
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
  if (!await newSession() || chat.session) throw new Error("Conversation changed. Open the report again to continue.");
  composer.text = "";
  composer.attachments = [{
    mimeType: "text/plain", url: "",
    report: { jobName: run.jobName, id: run.id, status: run.status },
    data: "[Attached Cron report]\n" + JSON.stringify({
      jobName: run.jobName, id: run.id, status: run.status,
      finished: new Date(run.endedAt || run.startedAt).toISOString(),
      output: run.output || "", error: run.error || "",
    }),
  }];
  saveDraft(); focusInput.value++;
}

export function stopFeeds() { activeFeed?.stop(); listFeed?.stop(); }
// A running session emits sessions_changed for every committed entry. Keep one list request in flight and
// fold any events that arrive meanwhile into a single trailing reload.
let listLoading: Promise<void> | undefined, listAgain = false;
function reloadList(): Promise<void> {
  if (listLoading) { listAgain = true; return listLoading; }
  listLoading = loadSessions().finally(() => {
    listLoading = undefined;
    if (listAgain) { listAgain = false; void reloadList().catch(() => {}); }
  });
  return listLoading;
}
export function startListFeed() {
  if (sessionPane) return; // The workspace shares list notifications; each tile keeps its own session feed.
  listFeed?.stop();
  let initial = true;
  listFeed = watchFeed({
    path: "/v1/events", api,
    onEvent: async type => {
      if (type === "sessions_changed") {
        // A failed first list read must retry the feed, not leave an empty sidebar until another commit.
        const loading = reloadList();
        if (initial) { await loading; initial = false; }
        else void loading.catch(() => {});
        notifySessionPanes(type); return;
      }
      if (type === "board_changed") { notifySessionPanes(type); boardChanged.value++; }
    },
    onDisconnect: e => e.message !== "unauthorized",
  });
}
window.addEventListener("message", async event => {
  if (!sessionPane || event.origin !== location.origin || event.source !== window.parent || event.data?.type !== "luna:workspace-event") return;
  if (event.data.event === "sessions_changed") void reloadList().catch(() => {});
  if (event.data.event === "board_changed") { boardChanged.value++; }
});
function reconnectFeeds() { activeFeed?.reconnect(); listFeed?.reconnect(); }
// Focus and visibility can arrive together. Keep a fresh or connecting feed instead of restarting it twice.
function resumeFeeds() { activeFeed?.reconnect(true); listFeed?.reconnect(true); }
window.addEventListener("online", reconnectFeeds);
window.addEventListener("focus", resumeFeeds);
document.addEventListener("visibilitychange", () => { if (!document.hidden) resumeFeeds(); });
window.addEventListener("pagehide", () => { saveDraft(); activeFeed?.stop(); listFeed?.stop(); cancelExtras(); if (liveFrame !== null) cancelAnimationFrame(liveFrame); });
window.addEventListener("pageshow", e => { if (e.persisted) { startListFeed(); if (chat.session) void openSession(chat.session); } });
