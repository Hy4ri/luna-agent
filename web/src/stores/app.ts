// App shell state: auth, pages, panels, drawer, sidebar geometry. Port of vanilla shell.js + panels.js open/close.
import { nextTick, reactive, ref } from "vue";
import { isDesktop, onUnauthorized, serverUrl, setServerUrl, setToken, token, url } from "@/lib/api";
import { connectionFailure, recoveryOpen, rememberConnection } from "@/lib/connections";
import { isMobile } from "@/lib/dom";
import { sections, resolveSettingsRoute } from "@/pages/settings/catalog";
import { sessionPane } from "@/lib/pane";
import * as chatStore from "./chat";
import * as modelsStore from "./models";
import * as sessionsStore from "./sessions";
import * as composerStore from "./composer";

export type View = "chat" | "analytics" | "github" | "settings";
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
  settingsTab: "chat",
  settingsTarget: "",
  settingsIndex: false,
  settingsNavigation: 0,
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
const settingsHash = () => "#settings/" + ui.settingsTab + (ui.settingsTarget ? "/" + ui.settingsTarget.split(".").map(encodeURIComponent).join("/") : "");
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
function closePage(view: "analytics" | "github") {
  if (ui.view !== view) return;
  ui.view = "chat";
  if (location.hash === "#" + view) clearHash();
  setDrawer(false);
}
export function openSettings(route?: string) {
  if (ui.login) return;
  if (ui.view === "settings" && guard?.canChangeTab?.() === false) {
    history.replaceState(null, "", settingsHash()); return;
  }
  ui.settingsIndex = !route && (location.hash === "#settings" || !location.hash.startsWith("#settings/"));
  const selected = route || (location.hash.startsWith("#settings/") ? location.hash.slice(10) : "chat");
  const { category, target } = resolveSettingsRoute(selected);
  ui.settingsTab = category;
  ui.settingsTarget = target;
  ui.settingsNavigation++;
  if (ui.view !== "settings") { closePanel(); closePage("analytics"); closePage("github"); ui.view = "settings"; }
  setDrawer(false);
  if (location.hash !== settingsHash()) history.replaceState(null, "", settingsHash());
}
/** Navigate inside Settings without discarding the shared draft. */
export function setSettingsTab(route: string) {
  if (guard?.canChangeTab?.() === false) return;
  ui.settingsIndex = false;
  const { category, target } = resolveSettingsRoute(route);
  ui.settingsTab = category;
  ui.settingsTarget = target;
  ui.settingsNavigation++;
  if (location.hash !== settingsHash()) history.replaceState(null, "", settingsHash());
}
function openPage(view: "analytics" | "github") {
  if (!closeSettings()) return;
  if (ui.login) return;
  closePanel(); setDrawer(false);
  ui.view = view;
  if (location.hash !== "#" + view) location.hash = view;
}
export const openAnalytics = () => openPage("analytics");
export const openGitHub = () => openPage("github");
/** "Back to chat" from any page. Focuses the composer. */
export function backToChat() {
  if (ui.view === "settings") { if (!closeSettings()) return; }
  else if (ui.view !== "chat") closePage(ui.view);
  focusInput.value++;
}
/** Leave whatever page is open (used before switching conversations). */
export function leavePages(): boolean {
  if (!closeSettings()) return false;
  if (ui.view === "analytics") closePage("analytics");
  if (ui.view === "github") closePage("github");
  return true;
}
export function navigate(view: View, tab?: string) {
  if (view === "settings") openSettings(tab);
  else if (view === "analytics") openAnalytics();
  else if (view === "github") openGitHub();
  else backToChat();
}

// ---- panels ----
let returnFocus: Element | null = null;
export function openPanel(name: string, options?: { keepSettings?: boolean }) {
  if (name === "settings") { closePanel(); return openSettings(); }
  if (name === "analytics") { closePanel(); return openAnalytics(); }
  if (name === "github") { closePanel(); return openGitHub(); }
  if (!options?.keepSettings && !closeSettings()) return;
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
    else if (ui.view === "github") document.getElementById("github-menu")?.focus();
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
  chatStore.stopFeeds();
  closePanel(); ui.drawer = false;
  ui.login = true; ui.loginError = err;
  void nextTick(() => { if (!recoveryOpen.value) document.getElementById("token")?.focus(); });
}
onUnauthorized(showLogin);
export function login(value: string, server?: string) {
  if (server !== undefined) setServerUrl(server);
  setToken(value.trim());
  sessionsStore.resetNotifications();
  ui.login = false; ui.loginError = "";
  setDrawer(false);
  void boot();
}

// Each split tile owns its feeds. Change every tile in the same task, without reloading the shell.
window.addEventListener("luna:can-switch-connection", event => {
  if (settingsDirty()) (event as CustomEvent).detail.error = "Save or discard settings before switching addresses.";
});
window.addEventListener("luna:switch-connection", event => {
  composerStore.saveDraft();
  chatStore.stopFeeds();
  chatStore.chat.connected = false;
  chatStore.chat.bootError = "";
  setServerUrl((event as CustomEvent).detail.target);
  ui.login = false; ui.loginError = "";
  void boot();
});
export function changeConnection(target: string) {
  const windows: Window[] = [window];
  for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe[data-tile-session]")) {
    if (frame.contentWindow) windows.push(frame.contentWindow);
  }
  const detail = { target, error: "" };
  for (const pane of windows) pane.dispatchEvent(new CustomEvent("luna:can-switch-connection", { detail }));
  if (detail.error) throw new Error(detail.error);
  if (!closeSettings()) return;
  // Verify persistence before changing live state. Keep drafts, attachments, and explicit retry IDs in memory.
  localStorage.setItem("luna.server", target);
  for (const pane of windows) pane.dispatchEvent(new CustomEvent("luna:switch-connection", { detail }));
}

// ---- boot ----
/** Keeps the sidebar unread count current while the Cron panel is closed. */
let bootGeneration = 0;
let badgeTimer: ReturnType<typeof setInterval> | undefined;
export async function boot() {
  const own = ++bootGeneration;
  // A tile can finish loading after the parent changes the route.
  const savedServer = localStorage.getItem("luna.server") || "";
  if (savedServer !== serverUrl.value) setServerUrl(savedServer);
  const chat = chatStore, models = modelsStore, sessions = sessionsStore, composer = composerStore;
  const badge = await import("@/pages/cron/badge");
  if (own !== bootGeneration) return;
  chat.chat.booting = true;
  try {
    if (isDesktop && !serverUrl.value) return showLogin();
    let hl;
    try { hl = await (await fetch(url("/health"), { signal: AbortSignal.timeout(5000), cache: "no-store" })).json(); }
    catch (e) { if (own !== bootGeneration) return; connectionFailure.value = true; if (isDesktop) return showLogin(`Cannot reach ${serverUrl.value}. Check the address and that the daemon runs.`); throw e; }
    if (own !== bootGeneration) return;
    if (hl.auth && !token.value) return showLogin();
    await rememberConnection();
    if (own !== bootGeneration) return;
    // Independent reads: fetch in parallel so boot costs one round trip, not three.
    await Promise.all([models.loadModels(), sessions.loadProjects(), sessions.loadSessions()]);
    if (own !== bootGeneration) return;
    if (chat.chat.session) await chat.openSession(chat.chat.session, true); else composer.restoreDraft();
    chat.startListFeed();
    void badge.refreshCronBadge();
    badgeTimer ??= setInterval(() => { if (!document.hidden) void badge.refreshCronBadge(); }, 30_000);
    applyHash();
  } catch (e) {
    if (own !== bootGeneration) return;
    if ((e as Error).message !== "unauthorized") chat.chat.bootError = String((e as Error).message || e);
  } finally { if (own === bootGeneration) chat.chat.booting = false; }
}

function applyHash() {
  const h = location.hash;
  if (h === "#settings" || h.startsWith("#settings/")) openSettings();
  else if (h === "#analytics") { if (ui.view !== "analytics") openAnalytics(); }
  else if (h === "#github") { if (ui.view !== "github") openGitHub(); }
  else if (h === "#cron") { history.replaceState(null, "", location.pathname + location.search); openPanel("cron"); }
}
window.addEventListener("hashchange", () => {
  const h = location.hash;
  if (h === "#settings" || h.startsWith("#settings/")) { openSettings(); return; }
  if (!closeSettings()) return;
  if (h === "#analytics" || h === "#github" || h === "#cron") applyHash();
  else { closePage("analytics"); closePage("github"); }
});
window.addEventListener("beforeunload", e => {
  if (ui.view === "settings" && guard?.isDirty()) { e.preventDefault(); e.returnValue = ""; }
});
