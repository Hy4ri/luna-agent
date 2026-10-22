// App shell state: auth, pages, panels, drawer, sidebar geometry. Port of vanilla shell.js + panels.js open/close.
import { nextTick, reactive, ref } from "vue";
import { isDesktop, onUnauthorized, serverUrl, setServerUrl, setToken, token, url } from "@/lib/api";
import { isMobile } from "@/lib/dom";
import { sections } from "@/pages/settings/catalog";
import { sessionPane } from "@/lib/pane";

export type View = "chat" | "cron" | "analytics" | "settings";
export const SETTINGS_TABS: readonly string[] = sections.map(section => section.id);
export const SIDE_MIN = 200, SIDE_MAX = 480, SIDE_DEFAULT = 264;

function savedWidth(): number | null {
  const w = Number(localStorage.getItem("luna.side.width"));
  return Number.isFinite(w) && w >= SIDE_MIN && w <= SIDE_MAX ? w : null;
}

export const ui = reactive({
  /** true: login dialog shown. */
  login: false,
  loginError: "",
  view: "chat" as View,
  settingsTab: "general",
  panel: null as string | null,
  drawer: false,
  collapsed: localStorage.getItem("luna.side.collapsed") === "1",
  sideWidth: savedWidth(),
  cronUnread: 0,
  /** Board edit form open: list-feed refreshes must not clobber it. */
  boardEditing: false,
  /** Command palette open. */
  palette: false,
});
/** Increments when settings are saved outside the Settings page. */
export const settingsChanged = ref(0);

export function setPalette(open: boolean) {
  if (open && (ui.login || sessionPane)) return;
  ui.palette = open;
}
/** Increments on every board_changed list-feed event. */
export const boardChanged = ref(0);
/** Increments when the composer input should take focus. */
export const focusInput = ref(0);

// ---- settings guard ----
export interface SettingsGuard { canLeave(): boolean; isDirty(): boolean; canChangeTab?(): boolean }
let guard: SettingsGuard | null = null;
export function setSettingsGuard(g: SettingsGuard | null) { guard = g; }
/** True while the Settings page holds unsaved or in-flight edits. */
export const settingsDirty = () => ui.view === "settings" && !!guard?.isDirty();
const settingsHash = (tab = ui.settingsTab) => (tab === "general" ? "#settings" : "#settings/" + tab);
const clearHash = () => history.replaceState(null, "", location.pathname + location.search);

/** Leave the Settings page. Returns false when the user keeps unsaved edits. */
export function closeSettings(force = false): boolean {
  if (ui.view !== "settings") return true;
  if (!force && guard && !guard.canLeave()) { history.replaceState(null, "", settingsHash()); return false; }
  guard = null; ui.view = "chat";
  if (location.hash.startsWith("#settings")) clearHash();
  setDrawer(false);
  return true;
}
function closePage(view: "cron" | "analytics") {
  if (ui.view !== view) return;
  ui.view = "chat";
  if (location.hash === "#" + view) clearHash();
  setDrawer(false);
}
export function openSettings(tab?: string) {
  if (ui.login) return;
  const selected = tab || (location.hash.startsWith("#settings/") ? location.hash.slice(10) : ui.view === "settings" ? ui.settingsTab : "general");
  const next = selected === "workspace" ? "context" : SETTINGS_TABS.includes(selected) ? selected : "general";
  if (ui.view === "settings" && next !== ui.settingsTab && guard?.canChangeTab?.() === false) {
    history.replaceState(null, "", settingsHash());
    return;
  }
  ui.settingsTab = next;
  if (ui.view !== "settings") { closePanel(); closePage("cron"); closePage("analytics"); ui.view = "settings"; setDrawer(false); }
  setDrawer(false);
  if (location.hash !== settingsHash()) location.hash = settingsHash().slice(1);
}
/** Called by the Settings page when the user switches tabs. */
export function setSettingsTab(id: string) {
  if (guard?.canChangeTab?.() === false) return;
  ui.settingsTab = id;
  if (location.hash !== settingsHash()) history.replaceState(null, "", settingsHash());
}
function openPage(view: "cron" | "analytics") {
  if (!closeSettings()) return;
  if (ui.login) return;
  closePanel(); setDrawer(false);
  ui.view = view;
  if (location.hash !== "#" + view) location.hash = view;
}
export const openCron = () => openPage("cron");
export const openAnalytics = () => openPage("analytics");
/** "Back to chat" from any page. Focuses the composer. */
export function backToChat() {
  if (ui.view === "settings") { if (!closeSettings()) return; }
  else if (ui.view !== "chat") closePage(ui.view);
  focusInput.value++;
}
/** Leave whatever page is open (used before switching conversations). */
export function leavePages(): boolean {
  if (!closeSettings()) return false;
  if (ui.view === "cron" || ui.view === "analytics") closePage(ui.view);
  return true;
}
export function navigate(view: View, tab?: string) {
  if (view === "settings") openSettings(tab);
  else if (view === "cron") openCron();
  else if (view === "analytics") openAnalytics();
  else backToChat();
}

// ---- panels ----
let returnFocus: Element | null = null;
export function openPanel(name: string) {
  if (name === "settings") { closePanel(); return openSettings(); }
  if (name === "analytics") { closePanel(); return openAnalytics(); }
  if (name === "cron") { closePanel(); return openCron(); }
  if (!closeSettings()) return;
  returnFocus = document.activeElement;
  setDrawer(false);
  ui.boardEditing = false;
  ui.panel = name;
  void nextTick(() => document.getElementById("pclose")?.focus());
}
export function closePanel() {
  if (!ui.panel) return;
  ui.panel = null;
  void nextTick(() => {
    const el = returnFocus as HTMLElement | null;
    if (el?.isConnected && !el.closest("[inert]") && el.offsetParent !== null) el.focus();
    else if (ui.view === "settings") document.getElementById("settings-menu")?.focus();
    else if (ui.view === "analytics") document.getElementById("analytics-menu")?.focus();
    else if (ui.view === "cron") document.getElementById("cron-menu")?.focus();
    else {
      const menu = document.getElementById("menu");
      (menu?.offsetParent ? menu : document.getElementById("more"))?.focus();
    }
  });
}

// ---- drawer + sidebar geometry ----
export function setDrawer(open: boolean) {
  ui.drawer = open;
  if (!isMobile()) return;
  void nextTick(() => {
    if (open) document.getElementById("side-close")?.focus();
    else document.getElementById(ui.view === "chat" ? "menu" : ui.view + "-menu")?.focus();
  });
}
export function setCollapsed(collapsed: boolean) {
  ui.collapsed = collapsed;
  localStorage.setItem("luna.side.collapsed", collapsed ? "1" : "0");
}
export const toggleCollapsed = () => setCollapsed(!ui.collapsed);
export function setSideWidth(px: number | null) {
  if (px === null) { ui.sideWidth = null; localStorage.removeItem("luna.side.width"); return; }
  const w = Math.round(Math.max(SIDE_MIN, Math.min(SIDE_MAX, px)));
  ui.sideWidth = w; localStorage.setItem("luna.side.width", String(w));
}

// ---- login ----
export function showLogin(err = "") {
  closeSettings(true);
  if (ui.view !== "chat") ui.view = "chat";
  void import("./chat").then(m => m.stopFeeds());
  closePanel(); ui.drawer = false;
  ui.login = true; ui.loginError = err;
  void nextTick(() => document.getElementById("token")?.focus());
}
onUnauthorized(showLogin);
export function login(value: string, server?: string) {
  if (server !== undefined) setServerUrl(server);
  setToken(value.trim());
  void import("./sessions").then(m => m.resetNotifications());
  ui.login = false; ui.loginError = "";
  setDrawer(false);
  void boot();
}

// ---- boot ----
export async function boot() {
  const chat = await import("./chat");
  const models = await import("./models");
  const sessions = await import("./sessions");
  const composer = await import("./composer");
  const badge = await import("@/pages/cron/badge");
  chat.chat.booting = true;
  try {
    if (isDesktop && !serverUrl.value) return showLogin();
    let hl;
    try { hl = await (await fetch(url("/health"))).json(); }
    catch (e) { if (isDesktop) return showLogin(`Cannot reach ${serverUrl.value}. Check the address and that the daemon runs.`); throw e; }
    if (hl.auth && !token.value) return showLogin();
    // Independent reads: fetch in parallel so boot costs one round trip, not three.
    await Promise.all([models.loadModels(), sessions.loadProjects(), sessions.loadSessions()]);
    if (chat.chat.session) await chat.openSession(chat.chat.session); else composer.restoreDraft();
    chat.startListFeed();
    void badge.refreshCronBadge();
    applyHash();
  } catch (e) {
    if ((e as Error).message !== "unauthorized") chat.chat.bootError = String((e as Error).message || e);
  } finally { chat.chat.booting = false; }
}

function applyHash() {
  const h = location.hash;
  if (h === "#settings" || h.startsWith("#settings/")) openSettings();
  else if (h === "#analytics") { if (ui.view !== "analytics") openAnalytics(); }
  else if (h === "#cron") { if (ui.view !== "cron") openCron(); }
}
window.addEventListener("hashchange", () => {
  const h = location.hash;
  if (h === "#settings" || h.startsWith("#settings/")) { openSettings(); return; }
  if (!closeSettings()) return;
  if (h === "#analytics" || h === "#cron") applyHash();
  else { closePage("cron"); closePage("analytics"); }
});
window.addEventListener("beforeunload", e => {
  if (ui.view === "settings" && guard?.isDirty()) { e.preventDefault(); e.returnValue = ""; }
});
