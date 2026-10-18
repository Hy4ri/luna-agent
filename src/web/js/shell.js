// Moved verbatim from the original inline app script; see CONTRACT.md module map.
import { createAnalyticsScreen } from "../analytics.js";
import { createCronScreen } from "../cron.js";
import { renderSettings } from "../settings.js";
import { json, onUnauthorized, post, setToken, token } from "./api.js";
import { grow, restoreDraft, saveDraft } from "./composer.js";
import { $, MOBILE, h, icon } from "./dom.js";
import { markdown } from "./markdown.js";
import { loadModels, modelList } from "./models.js";
import { closePanel, currentPanel } from "./panels.js";
import { newSession, openSession, scheduleContext, session, startListFeed, stopFeeds, updateRunControls } from "./session.js";
import { loadProjects, loadSessions } from "./sidebar.js";
import { showWelcome } from "./transcript.js";

export let cronOpen = false;
let cronScreen;
export let analyticsOpen = false;
let analyticsScreen;
export let settingsOpen = false;
let settingsController = null;
let settingsEpoch = 0;
let settingsTab = "general";
export function setDrawer(open) {
  $("side").classList.toggle("open", open);
  $("shade").classList.toggle("open", open);
  $("menu").setAttribute("aria-expanded", String(open));
  const mobile = matchMedia(MOBILE).matches;
  $("side").inert = !!currentPanel || (mobile && !open);
  $("main").inert = !!currentPanel || (mobile && open);
  $("cron-screen").inert = !!currentPanel || (mobile && open);
  $("analytics-screen").inert = !!currentPanel || (mobile && open);
  $("settings-screen").inert = !!currentPanel || (mobile && open);
  if (mobile && open) $("side-close").focus();
  else if (mobile) (settingsOpen ? $("settings-menu") : analyticsOpen ? $("analytics-menu") : cronOpen ? $("cron-menu") : $("menu"))?.focus();
}
matchMedia(MOBILE).addEventListener("change", () => setDrawer(false));
$("side-close").onclick = () => setDrawer(false);
$("shade").onclick = () => setDrawer(false);

function showLogin(err) { closeSettingsScreen(true); $("settings-screen").inert = true; if (analyticsOpen) closeAnalyticsScreen(); if (cronOpen) { cronScreen.close(); cronOpen = false; $("cron-screen").hidden = true; $("main").hidden = false; } stopFeeds(); closePanel(); setDrawer(false); $("main").inert = true; $("side").inert = true; $("cron-screen").inert = true; $("analytics-screen").inert = true; $("login").style.display = "flex"; $("loginErr").textContent = err || ""; $("token").focus(); }
onUnauthorized(showLogin);
$("loginForm").onsubmit = (e) => { e.preventDefault(); setToken($("token").value.trim()); localStorage.setItem("luna.token", token); $("login").style.display = "none"; setDrawer(false); boot(); };

$("menu").onclick = () => setDrawer(!$("side").classList.contains("open"));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (currentPanel) closePanel(); else if ($("side").classList.contains("open")) setDrawer(false); else if (settingsOpen) closeSettingsScreen(); }
  if (e.key !== "Tab") return;
  const root = $("login").style.display === "flex" ? $("login") : currentPanel ? $("panel") : matchMedia(MOBILE).matches && $("side").classList.contains("open") ? $("side") : null;
  if (!root) return;
  const items = [...root.querySelectorAll('button:not(:disabled),input,textarea,select,a[href],[tabindex="0"]')].filter(el => el.offsetParent !== null && !el.disabled);
  const first = items[0], last = items.at(-1);
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
});

// Cron is a page, not a modal panel. Chat stays attached while the page is open.
export function closeCronScreen() {
  if (!cronOpen) return;
  cronOpen = false; cronScreen.close();
  $("cron-screen").hidden = true; $("main").hidden = false;
  document.querySelector('[data-panel="cron"]').removeAttribute("aria-current");
  if (location.hash === "#cron") history.replaceState(null, "", location.pathname + location.search);
  setDrawer(false);
}
export function openCronScreen() {
  if (!closeSettingsScreen()) return;
  if ($("login").style.display === "flex") return;
  closePanel();
  closeAnalyticsScreen();
  setDrawer(false); cronOpen = true;
  $("main").hidden = true; $("cron-screen").hidden = false;
  document.querySelector('[data-panel="cron"]').setAttribute("aria-current", "page");
  if (location.hash !== "#cron") location.hash = "cron";
  cronScreen.open();
}
cronScreen = createCronScreen({
  root: $("cron-screen"), h, json, post, markdown,
  onClose: () => { closeCronScreen(); $("input").focus(); },
  onUnread: count => { const badge = $("cron-unread"); badge.hidden = !count; badge.textContent = String(count); },
  onContinue: async run => {
    // Create a new conversation but do not submit the report or start a model call.
    const id = await newSession();
    if (String(id) !== session) throw new Error("Conversation changed. Open the report again to continue.");
    closeCronScreen();
    $("input").value = `Discuss this Cron report.\nJob: ${run.jobName}\nRun: #${run.id}\nFinished: ${new Date(run.endedAt || run.startedAt).toISOString()}\nStatus: ${run.status}\n\n${[run.output, run.error ? "Error: " + run.error : null].filter(Boolean).join("\n\n") || "(No output)"}\n\n`;
    grow(); saveDraft(); $("input").focus();
  },
});
// Keep the mobile navigation available on the full page without duplicating the workspace.
const cronMenu = h("button", { id: "cron-menu", class: "icon-button", "aria-label": "Open navigation", "aria-controls": "side", onclick: () => setDrawer(true) });
cronMenu.append(icon("menu"));
// Renderer may replace its content when switching tabs. Restore the navigation button in its header.
new MutationObserver(() => {
  if (cronOpen && !cronMenu.isConnected) {
    const header = $("cron-screen").querySelector("header");
    if (header) header.prepend(cronMenu);
  }
}).observe($("cron-screen"), { childList: true, subtree: true });
export function closeAnalyticsScreen() {
  if (!analyticsOpen) return;
  analyticsOpen = false; analyticsScreen.close();
  $("analytics-screen").hidden = true; $("main").hidden = false;
  document.querySelector('[data-panel="analytics"]').removeAttribute("aria-current");
  if (location.hash === "#analytics") history.replaceState(null, "", location.pathname + location.search);
  setDrawer(false);
}
export function openAnalyticsScreen() {
  if (!closeSettingsScreen()) return;
  if ($("login").style.display === "flex") return;
  closePanel(); closeCronScreen(); setDrawer(false);
  analyticsOpen = true; $("main").hidden = true; $("analytics-screen").hidden = false;
  document.querySelector('[data-panel="analytics"]').setAttribute("aria-current", "page");
  if (location.hash !== "#analytics") location.hash = "analytics";
  analyticsScreen.open();
}
analyticsScreen = createAnalyticsScreen({
  root: $("analytics-screen"), h, json,
  onClose: () => { closeAnalyticsScreen(); $("input").focus(); },
  onMenu: () => setDrawer(true),
});
// Settings has one draft across its tabs. Detached loads cannot reopen a closed page.
function settingsHash(tab = settingsTab) { return tab === "general" ? "#settings" : "#settings/" + tab; }
export function closeSettingsScreen(force = false) {
  if (!settingsOpen) return true;
  if (!force && settingsController && !settingsController.canLeave()) {
    history.replaceState(null, "", settingsHash());
    return false;
  }
  settingsOpen = false; settingsController = null; settingsEpoch++;
  $("settings-screen").hidden = true; $("main").hidden = false;
  document.querySelector('[data-panel="settings"]').removeAttribute("aria-current");
  if (location.hash.startsWith("#settings")) history.replaceState(null, "", location.pathname + location.search);
  setDrawer(false);
  return true;
}
export async function openSettingsScreen(tab) {
  if ($("login").style.display === "flex") return;
  const known = ["general", "models", "context", "tools", "automation"];
  const selected = tab || (location.hash.startsWith("#settings/") ? location.hash.slice(10) : settingsOpen ? settingsTab : "general");
  settingsTab = known.includes(selected) ? selected : "general";
  if (settingsOpen) { settingsController?.selectTab(settingsTab, false); return; }
  closePanel(); closeCronScreen(); closeAnalyticsScreen();
  settingsOpen = true; setDrawer(false);
  $("main").hidden = true; $("settings-screen").hidden = false;
  document.querySelector('[data-panel="settings"]').setAttribute("aria-current", "page");
  if (location.hash !== settingsHash()) location.hash = settingsHash().slice(1);
  const epoch = ++settingsEpoch;
  const menu = h("button", { id: "settings-menu", class: "icon-button", "aria-label": "Open navigation", "aria-controls": "side", onclick: () => setDrawer(true) });
  menu.append(icon("menu"));
  const close = h("button", { type: "button", "data-settings-close": "", onclick: () => { if (closeSettingsScreen()) $("input").focus(); } }, "Back to chat");
  const body = h("div", { class: "settings-body" });
  $("settings-screen").replaceChildren(h("header", {}, menu, h("h1", {}, "Settings"), close), body);
  body.append(h("p", { role: "status", class: "muted" }, "Loading settings…"));
  try {
    const content = h("div", { class: "grid" });
    const controller = await renderSettings(content, { h, json, post, loadModels, getModels: () => modelList, onSaved: scheduleContext,
      initialTab: settingsTab, onTabChange: id => { settingsTab = id; if (location.hash !== settingsHash()) history.replaceState(null, "", settingsHash()); } });
    if (!settingsOpen || epoch !== settingsEpoch) return;
    settingsController = controller;
    controller.selectTab(settingsTab, false);
    body.replaceChildren(content);
  } catch (e) {
    if (!settingsOpen || epoch !== settingsEpoch) return;
    body.replaceChildren(h("p", { role: "alert", class: "msg err" }, e.message), h("button", { onclick: () => { closeSettingsScreen(true); openSettingsScreen(settingsTab); } }, "Retry"));
  }
}
window.addEventListener("beforeunload", e => {
  if (settingsOpen && settingsController?.isDirty()) { e.preventDefault(); e.returnValue = ""; }
});
window.addEventListener("hashchange", () => {
  if (location.hash === "#settings" || location.hash.startsWith("#settings/")) { openSettingsScreen(); return; }
  if (!closeSettingsScreen()) return;
  if (location.hash === "#analytics") { if (!analyticsOpen) openAnalyticsScreen(); }
  else if (location.hash === "#cron") { if (!cronOpen) openCronScreen(); }
  else { closeCronScreen(); closeAnalyticsScreen(); }
});

export async function boot() {
  $("send").disabled = true;
  try {
    const hl = await (await fetch("/health")).json();
    if (hl.auth && !token) return showLogin();
    await loadModels();
    await loadProjects();
    await loadSessions();
    if (session) await openSession(session); else restoreDraft();
    startListFeed(); showWelcome(); updateRunControls();
    cronScreen.refreshBadge();
    if (location.hash === "#cron") openCronScreen();
    else if (location.hash === "#analytics") openAnalyticsScreen();
    else if (location.hash === "#settings" || location.hash.startsWith("#settings/")) openSettingsScreen();
  } catch (e) { if (e.message !== "unauthorized") $("status").textContent = String(e.message || e); }
}
