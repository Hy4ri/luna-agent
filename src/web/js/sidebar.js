// Moved verbatim from the original inline app script; see CONTRACT.md module map.
import { api, json } from "./api.js";
import { $, h, icon } from "./dom.js";
import { openPanel } from "./panels.js";
import { clearConversation, newSession, openSession, session } from "./session.js";
import { setDrawer } from "./shell.js";
import { addErr } from "./transcript.js";

export let sessionList = [];
let historyRequest = 0;
export let projectList = [];
const projectName = id => projectList.find(p => p.id === id)?.name;
export async function loadProjects() {
  const sel = $("project"), keep = sel.value || localStorage.getItem("luna.project") || "";
  projectList = (await json("/v1/projects").catch(() => ({ projects: [] }))).projects;
  sel.replaceChildren(h("option", { value: "" }, "No project"), ...projectList.map(p => h("option", { value: String(p.id), title: p.cwd }, p.name)));
  sel.value = projectList.some(p => String(p.id) === keep) ? keep : "";
  renderSessions();
}
$("project").onchange = () => localStorage.setItem("luna.project", $("project").value);
export async function loadSessions() {
  const request = ++historyRequest;
  const r = await json("/v1/sessions");
  if (request !== historyRequest) return;
  sessionList = r.sessions;
  const active = sessionList.find(s => String(s.id) === String(session));
  if (active?.title) $("title").textContent = active.title;
  // A deletion from another device must detach this viewer too. Hidden subagents are not list members.
  if (session && !active) {
    const sid = session;
    const response = await api(`/v1/sessions/${sid}?limit=1`);
    if (request !== historyRequest) return;
    if (response.status === 404 && sid === session) clearConversation();
  }
  renderSessions();
}
export function renderSessions() {
  const box = $("sessions"); box.replaceChildren();
  const query = $("search").value.trim().toLowerCase();
  const archived = $("history-view").value === "archived";
  const shown = sessionList.filter(s => !!s.archived === archived && (s.title || "Conversation " + s.id).toLowerCase().includes(query))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned));
  let pinnedHeading = false, otherHeading = false;
  for (const s of shown) {
    const active = String(s.id) === String(session);
    if (s.pinned && !pinnedHeading) { box.append(h("div", { class: "eyebrow" }, "Pinned")); pinnedHeading = true; }
    if (!s.pinned && pinnedHeading && !otherHeading) { box.append(h("div", { class: "eyebrow" }, "Other conversations")); otherHeading = true; }
    const b = h("button", { class: "session-open" + (active ? " on" : ""), "aria-current": active ? "page" : null, onclick: () => { setDrawer(false); openSession(s.id).catch(e => addErr(e.message)); } }, s.title || "Conversation " + s.id);
    b.title = b.textContent;
    const manage = h("button", { class: "session-manage", "aria-label": "Manage " + (s.title || "Conversation " + s.id), onclick: () => { managedSession = s.id; openPanel("conversation"); } });
    manage.append(icon("more"));
    box.append(h("div", { class: "session-row", "data-session": s.id }, b,
      s.project && projectName(s.project) ? h("span", { class: "session-running muted", title: "Project" }, projectName(s.project)) : null,
      s.running ? h("span", { class: "session-running muted", "data-running": "true", "aria-label": "Running" }, "Running") : null, manage));
  }
  if (!shown.length) box.append(h("p", { class: "muted" }, query ? "No matching conversations." : archived ? "No archived conversations." : "Your conversations will appear here."));
}
$("search").oninput = renderSessions;
$("history-view").onchange = () => loadSessions().catch(e => addErr(e.message));
export let managedSession = null;
$("new").onclick = async () => { try { const id = await newSession(); if (String(id) === session) { setDrawer(false); $("input").focus(); } } catch (e) { addErr(e.message); } };
