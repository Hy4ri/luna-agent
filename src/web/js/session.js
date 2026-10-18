// Moved verbatim from the original inline app script; see CONTRACT.md module map.
import { watchFeed } from "../sync.js";
import { api, json, post } from "./api.js";
import { renderSendError, restoreDraft, saveDraft, submissions } from "./composer.js";
import { $ } from "./dom.js";
import { EXTRA_TOOLS, cancelExtras, renderExtras, scheduleExtras } from "./extras.js";
import { defaultModel, setSelectedModel } from "./models.js";
import { boardEditing, currentPanel, refresh } from "./panels.js";
import { analyticsOpen, closeAnalyticsScreen, closeCronScreen, closeSettingsScreen, cronOpen } from "./shell.js";
import { loadSessions, renderSessions, sessionList } from "./sidebar.js";
import { addAssistant, addErr, addTool, addUser, clearSideJobs, finishTool, renderSideJobs, scroll, setAssistant, setSideJobs, showUsage, showWelcome, sideJobs, textBlocks } from "./transcript.js";

export let session = sessionStorage.getItem("luna.session") || localStorage.getItem("luna.session") || null;
let busy = false;

// Context is a request-size estimate, not the cumulative usage shown beside it.
let contextTimer, contextRevision = 0, contextCompacting = false;
let activeCompactions = new Set();
function showContextUsage(value) {
  const bar = $("context-bar"), meter = $("context-meter");
  bar.hidden = !value;
  if (!value) return;
  contextCompacting = !!value.compacting;
  const known = Number.isFinite(value.contextWindow) && value.contextWindow > 0 && Number.isFinite(value.percent);
  const percent = known ? value.percent : null;
  bar.dataset.level = known ? percent >= value.triggerPercent ? "red" : percent >= 50 ? "amber" : "green" : "unknown";
  $("context-fill").style.width = known ? Math.max(0, Math.min(100, percent)) + "%" : "0%";
  meter.hidden = !known;
  if (known) {
    meter.setAttribute("aria-valuenow", String(Math.max(0, Math.min(100, percent))));
    meter.setAttribute("aria-valuetext", percent.toFixed(1) + "% of model context, estimated");
  } else { meter.removeAttribute("aria-valuenow"); meter.removeAttribute("aria-valuetext"); }
  const tokens = Math.round(value.usedTokens).toLocaleString();
  $("context-text").textContent = known ? `Context ≈${tokens} / ${value.contextWindow.toLocaleString()} · ${percent.toFixed(1)}%` : `Context ≈${tokens} tokens · capacity unavailable`;
  bar.title = `Estimated active context. Automatic compaction ${value.autoCompactionEnabled ? "at " + value.triggerPercent + "%" : "disabled"}.`;
  updateRunControls();
}
export function scheduleContext() {
  clearTimeout(contextTimer);
  const sid = session, epoch = viewEpoch, revision = ++contextRevision;
  if (!sid) return;
  contextTimer = setTimeout(async () => {
    try {
      const value = await json(`/v1/sessions/${sid}/context`);
      if (sid === session && epoch === viewEpoch && revision === contextRevision) showContextUsage(value);
    } catch {
      if (sid === session && epoch === viewEpoch && revision === contextRevision) {
        $("context-bar").hidden = false; $("context-meter").hidden = true;
        $("context-text").textContent = "Context usage unavailable";
      }
    }
  }, 80);
}
// ---- sessions ----
export let viewEpoch = 0, activeFeed = null, listFeed = null;
let connected = false, runActive = false, generationActive = false, queuedCount = 0;
let liveMessage = null, partialView = null, partialFrame = null;
let entries = new Map(), toolViews = new Map(), activeTools = new Set();
function detachView() {
  $("busyFeedback").hidden = true; $("busyFeedback").textContent = "";
  clearSideJobs();
  viewEpoch++; activeFeed?.stop(); activeFeed = null;
  cancelExtras(); clearTimeout(contextTimer); contextRevision++;
  contextCompacting = false; activeCompactions = new Set(); showContextUsage(null);
  cancelAnimationFrame(partialFrame); partialFrame = null;
  connected = false; runActive = generationActive = false; queuedCount = 0;
  liveMessage = partialView = null; entries = new Map(); toolViews = new Map(); activeTools = new Set();
}
export function clearConversation() {
  saveDraft(); detachView(); session = null; localStorage.removeItem("luna.session"); sessionStorage.removeItem("luna.session");
  $("title").textContent = "New conversation"; $("log").replaceChildren(); $("extras").replaceChildren();
  setSelectedModel(defaultModel); $("think").value = "off"; showUsage(null);
  restoreDraft(); updateRunControls(); showWelcome(); renderSessions();
}
function renderTranscript(force = false) {
  const log = $("log"), top = log.scrollTop, follow = force || log.scrollHeight - top - log.clientHeight < 200;
  const expanded = new Set([...log.querySelectorAll("details[open][data-call]")].map(d => d.dataset.call));
  log.replaceChildren(); partialView = null; toolViews = new Map();
  const tool = (id, name, args) => {
    let view = toolViews.get(id);
    if (!view) { view = addTool(name, args); view.el.dataset.call = id; view.el.open = expanded.has(String(id)); toolViews.set(id, view); }
    return view;
  };
  for (const e of [...entries.values()].sort((a, b) => a.id - b.id)) {
    if (e.kind === "pi.reset") { addErr("— context reset —").className = "msg muted"; continue; }
    if (e.kind === "pi.compaction") { addErr("— earlier messages compacted —").className = "msg muted"; continue; }
    const m = e.model?.[0]; if (!m) continue;
    if (m.role === "user") addUser(m.content).dataset.entry = e.id;
    else if (m.role === "assistant") {
      const text = textBlocks(m.content); if (text) addAssistant(text).dataset.entry = e.id;
      for (const c of m.content || []) if (c.type === "toolCall") tool(c.id, c.name, c.arguments);
      if (m.stopReason === "error" && m.errorMessage) addErr(m.errorMessage);
    } else if (m.role === "toolResult") finishTool(tool(m.toolCallId, m.toolName || "tool"), m);
  }
  renderPartial(); renderSideJobs(); renderSendError(); showWelcome();
  if (follow) scroll(true); else log.scrollTop = top;
}
function renderPartial() {
  const text = textBlocks(liveMessage?.content);
  if (text) { if (!partialView) partialView = addAssistant(text); else setAssistant(partialView, text); }
  else { partialView?.remove(); partialView = null; }
}
function queuePartialRender(epoch) {
  if (partialFrame !== null) return;
  partialFrame = requestAnimationFrame(() => { partialFrame = null; if (epoch === viewEpoch) { renderPartial(); scroll(); } });
}
function applyAgent(agent) {
  setSelectedModel(agent.model || defaultModel); $("think").value = agent.thinkingLevel || "off";
}
function onSessionEvent(type, e, epoch) {
  if (epoch !== viewEpoch) return;
  if (type === "side_jobs") {
    setSideJobs(e.jobs); return;
  }
  if (type === "side_job") { sideJobs.set(e.id, e); renderSideJobs(); return; }
  if (type === "snapshot") {
    connected = true;
    for (const entry of e.entries || []) entries.set(entry.id, entry);
    runActive = !!e.run; generationActive = !!e.generation; queuedCount = e.inbox?.length || 0;
    activeCompactions = new Set((e.compactions || []).map(c => c.taskId));
    contextCompacting = activeCompactions.size > 0; scheduleContext();
    activeTools = new Set([...(e.tools || []), ...(e.nestedTools || [])].filter(t => t.status !== "done").map(t => t.callId));
    liveMessage = e.generation?.message ? structuredClone(e.generation.message) : null;
    applyAgent(e.agent || {}); showUsage(e.usage); renderTranscript();
    for (const slot of [...(e.tools || []), ...(e.nestedTools || [])]) {
      let view = toolViews.get(slot.callId);
      if (!view && slot.status !== "done") {
        view = addTool(slot.name, slot.arguments); view.el.dataset.call = slot.callId; toolViews.set(slot.callId, view);
      }
      if (view && slot.status !== "done" && slot.output) view.pre.textContent = slot.output;
    }
    scheduleExtras();
  } else if (type === "message_start" && e.message.role === "assistant") {
    generationActive = true; liveMessage = structuredClone(e.message); queuePartialRender(epoch);
  } else if (type === "message_update") {
    generationActive = true;
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
    queuePartialRender(epoch);
  } else if (type === "message_end" || type === "entry_appended") {
    if (e.entry.model?.[0]?.role === "assistant") liveMessage = null;
    entries.set(e.entry.id, e.entry); renderTranscript(); scheduleExtras(); scheduleContext();
  } else if (type === "run_start") { runActive = true; }
  else if (type === "run_end") { runActive = generationActive = false; activeTools.clear(); liveMessage = null; renderPartial(); scheduleExtras(); scheduleContext(); }
  else if (type === "turn_start") generationActive = true;
  else if (type === "turn_end") generationActive = false;
  else if (type === "inbox_update") queuedCount = e.items.length;
  else if (type === "agent_changed") { applyAgent(e.agent); scheduleContext(); }
  else if (type === "usage_changed") { showUsage(e.usage); scheduleContext(); }
  else if (type === "compaction_start") { activeCompactions.add(e.taskId); contextCompacting = true; scheduleContext(); }
  else if (type === "compaction_end") {
    activeCompactions.delete(e.taskId); contextCompacting = activeCompactions.size > 0;
    if (e.error) addErr("Context compaction failed: " + e.error);
    scheduleContext();
  }
  else if (type === "tool_execution_start") {
    activeTools.add(e.toolCallId);
    if (!toolViews.has(e.toolCallId)) { const v = addTool(e.toolName, e.args); v.el.dataset.call = e.toolCallId; toolViews.set(e.toolCallId, v); }
    if (EXTRA_TOOLS.test(e.toolName)) scheduleExtras(e.toolName === "ask_user_question" ? 3 : 0);
  } else if (type === "tool_execution_update" && e.output) {
    const view = toolViews.get(e.toolCallId);
    if (view) {
      if ("set" in e.output) view.pre.textContent = e.output.set;
      else view.pre.textContent = view.pre.textContent.slice(e.output.trimStart || 0) + (e.output.append || "");
    }
  } else if (type === "tool_execution_end") { activeTools.delete(e.toolCallId); scheduleExtras(); scheduleContext(); }
  else if (type === "task_failed") addErr(e.message);
  else if (type === "submission") {
    if (e.record.status === "unanswered") addErr(e.record.reason + (e.record.detail ? ": " + (typeof e.record.detail === "string" ? e.record.detail : JSON.stringify(e.record.detail)) : ""));
    scheduleExtras();
  }
  updateRunControls();
}
export async function openSession(id) {
  if (!closeSettingsScreen()) return;
  if (analyticsOpen) closeAnalyticsScreen();
  if (cronOpen) closeCronScreen();
  saveDraft(); detachView();
  session = String(id); localStorage.setItem("luna.session", session); sessionStorage.setItem("luna.session", session);
  const sid = session, epoch = viewEpoch;
  $("log").replaceChildren(); $("extras").replaceChildren();
  $("title").textContent = sessionList.find(s => String(s.id) === sid)?.title || "Conversation " + sid;
  restoreDraft(); updateRunControls(); renderSessions();
  // Hydrate durable history on EVERY attachment. Its subsequent atomic snapshot closes the fetch/subscribe gap.
  activeFeed = watchFeed({ path: `/v1/sessions/${sid}/events`, api,
    beforeConnect: async signal => {
      const s = await json(`/v1/sessions/${sid}?limit=500`, { signal });
      if (epoch !== viewEpoch) return;
      entries = new Map(s.entries.map(e => [e.id, e]));
      applyAgent(s.agent); showUsage(s.usage); showContextUsage(s.contextUsage); renderExtras(s); renderTranscript(true);
    },
    onEvent: (type, e) => onSessionEvent(type, e, epoch),
    onDisconnect: error => {
      if (epoch !== viewEpoch) return false;
      if (error.status === 404) { clearConversation(); loadSessions().catch(() => {}); return false; }
      connected = false; updateRunControls(); return error.message !== "unauthorized";
    },
  });
}
export async function newSession() {
  if (!closeSettingsScreen()) return;
  const epoch = viewEpoch;
  const { id } = await post("/v1/sessions", $("project").value ? { project: Number($("project").value) } : {});
  // A delayed create response cannot take over a conversation the user selected in the meantime.
  if (epoch !== viewEpoch) return id;
  $("history-view").value = "active"; $("search").value = "";
  await openSession(id); loadSessions().catch(() => {});
  return id;
}
export const stopFeeds = () => { activeFeed?.stop(); listFeed?.stop(); };
export function startListFeed() {
  listFeed?.stop();
  listFeed = watchFeed({ path: "/v1/events", api, onEvent: type => { if (type === "sessions_changed") return loadSessions(); if (type === "board_changed" && currentPanel === "board" && !boardEditing) return refresh(); }, onDisconnect: e => e.message !== "unauthorized" });
}
function reconnectFeeds() { activeFeed?.reconnect(); listFeed?.reconnect(); }
window.addEventListener("online", reconnectFeeds);
document.addEventListener("visibilitychange", () => { if (!document.hidden) reconnectFeeds(); });
window.addEventListener("pagehide", () => { saveDraft(); activeFeed?.stop(); listFeed?.stop(); cancelExtras(); cancelAnimationFrame(partialFrame); });
window.addEventListener("pageshow", e => { if (e.persisted) { startListFeed(); if (session) openSession(session); } });
// ---- durable submission; the view observes the run independently ----
export function updateRunControls() {
  busy = runActive || generationActive || activeTools.size > 0 || queuedCount > 0 || contextCompacting || activeCompactions.size > 0;
  const sending = submissions.has(session);
  $("send").disabled = sending || (!!session && !connected);
  $("stop").disabled = !busy || !connected;
  const waiting = [...activeTools].some(id => toolViews.get(id)?.name === "ask_user_question");
  $("status").textContent = sending ? "Sending…" : session && !connected ? "Reconnecting…" : contextCompacting || activeCompactions.size > 0 ? "Compacting context…" : waiting ? "Waiting for your answer…"
    : queuedCount ? `Running · ${queuedCount} queued` : busy ? (textBlocks(liveMessage?.content) ? "Writing…" : "Running…") : "Ready";
}
$("stop").onclick = async () => {
  const sid = session, epoch = viewEpoch;
  if (!sid) return;
  try { await post(`/v1/sessions/${sid}/abort`); }
  catch (e) { if (epoch === viewEpoch) addErr(e.message); }
};
