// Moved verbatim from the original inline app script; see CONTRACT.md module map.
import { json, post } from "./api.js";
import { send } from "./composer.js";
import { $, h } from "./dom.js";
import { session, viewEpoch } from "./session.js";
import { addErr } from "./transcript.js";

let extrasTimer = null;
// ---- todos, open questions, goal (ported plugins) ----
export const EXTRA_TOOLS = /^(todo|ask_user_question|create_goal|update_goal|set_goal_tasks|update_goal_task)$/;
let answering = new Set();
async function loadExtras(retries = 0, sid = session, epoch = viewEpoch) {
  if (!sid || epoch !== viewEpoch) return;
  const s = await json(`/v1/sessions/${sid}?limit=1`).catch(() => null);
  if (!s || sid !== session || epoch !== viewEpoch) return;
  renderExtras(s);
  if (retries && !s.questions.length) extrasTimer = setTimeout(() => loadExtras(retries - 1, sid, epoch), 500);
}
export function renderExtras(s) {
  const box = $("extras");
  // Keep a questionnaire the user is filling in.
  const keep = [...box.querySelectorAll("[data-ask]")].filter((f) => s.questions.some((q) => q.callId === f.dataset.ask));
  box.replaceChildren();
  if (s.goal) box.append(goalCard(s.goal));
  const todos = s.todos || [];
  if (todos.length) {
    const done = todos.filter((t) => t.status === "completed").length;
    const mark = { pending: "○", in_progress: "◐", completed: "✓" };
    box.append(h("details", { class: "card todo", open: "" }, h("summary", { class: "muted" }, `Todos ${done}/${todos.length}`),
      ...todos.map((t) => h("div", { class: t.status === "completed" ? "done" : "" }, `${mark[t.status] || "·"} #${t.id} ${t.subject}${t.status === "in_progress" && t.activeForm ? " — " + t.activeForm : ""}${t.blockedBy?.length ? " · Blocked by " + t.blockedBy.map((i) => "#" + i).join(",") : ""}`))));
  }
  for (const q of s.questions || []) box.append(keep.find((f) => f.dataset.ask === q.callId) || askForm(q));
}
function goalCard(g) {
  const sid = session, epoch = viewEpoch;
  const done = g.tasks.filter((t) => t.status !== "pending").length;
  const act = (action) => async () => { try { await post(`/v1/sessions/${sid}/goal`, { action }, "PATCH"); if (epoch === viewEpoch) loadExtras(); } catch (e) { if (epoch === viewEpoch) addErr(e.message); } };
  const open = g.status !== "complete";
  return h("div", { class: "card grid" },
    h("div", { class: "row" }, h("b", {}, "Goal " + g.id), h("span", { class: "pill " + (g.status === "complete" ? "ok" : g.status === "active" ? "running" : "") }, g.status),
      h("span", { class: "grow muted" }, `runs ${g.runs}/${g.maxRuns}${g.tasks.length ? ` · tasks ${done}/${g.tasks.length}` : ""}${g.tokenBudget ? ` · ${g.tokensUsed}/${g.tokenBudget} tok` : ""}`),
      open && g.status === "active" ? h("button", { onclick: act("pause") }, "Pause") : null,
      open && g.status !== "active" ? h("button", { onclick: act("resume") }, "Resume") : null,
      h("button", { onclick: () => confirm("Clear this goal?") && act("clear")() }, "Clear")),
    h("span", { class: "muted" }, g.objective.length > 200 ? g.objective.slice(0, 200) + "…" : g.objective),
    g.statusReason ? h("span", { class: "muted" }, g.statusReason) : null);
}
function askForm(p) {
  const sid = session, epoch = viewEpoch;
  const form = h("form", { class: "card grid" });
  form.dataset.ask = p.callId;
  const read = [];
  p.questions.forEach((q, qi) => {
    const name = `q${p.callId}-${qi}`, type = q.multiSelect ? "checkbox" : "radio";
    const custom = h("input", { placeholder: "Or type your own answer" });
    const opts = q.options.map((o) => {
      const inp = h("input", { type, name, value: o.label });
      return { inp, row: h("label", { class: "opt" }, inp, h("span", {}, h("b", {}, o.label), h("div", { class: "muted" }, o.description), o.preview ? h("pre", { class: "code" }, o.preview) : null)) };
    });
    form.append(h("div", { class: "grid" }, h("div", { class: "row" }, h("span", { class: "pill" }, q.header), h("b", { class: "grow" }, q.question)), ...opts.map((o) => o.row), custom));
    read.push(() => {
      const picked = opts.filter((o) => o.inp.checked).map((o) => o.inp.value), text = custom.value.trim();
      if (q.multiSelect) return picked.length || text ? { questionIndex: qi, kind: "multi", selected: picked, answer: text || null } : null;
      if (text) return { questionIndex: qi, kind: "custom", answer: text };
      return picked.length ? { questionIndex: qi, kind: "option", answer: picked[0] } : null;
    });
  });
  const note = h("input", { placeholder: "Note for Luna (optional)" });
  const send = async (body) => {
    if (answering.has(p.callId)) return;
    answering.add(p.callId);
    try { await post(`/v1/sessions/${sid}/questions/${encodeURIComponent(p.callId)}`, body); form.remove(); }
    catch (e) { if (epoch === viewEpoch) addErr(e.message); } finally { answering.delete(p.callId); }
  };
  form.onsubmit = (e) => { e.preventDefault(); send({ answers: read.map((r) => r()).filter(Boolean), ...(note.value.trim() ? { globalNote: note.value.trim() } : {}) }); };
  form.append(note, h("div", { class: "row" }, h("button", {}, "Answer"), h("button", { type: "button", onclick: () => send({ cancelled: true }) }, "Decline")));
  return form;
}

export const cancelExtras = () => clearTimeout(extrasTimer);
export function scheduleExtras(retries = 0) {
  clearTimeout(extrasTimer);
  const sid = session, epoch = viewEpoch;
  extrasTimer = setTimeout(() => loadExtras(retries, sid, epoch), 80);
}
