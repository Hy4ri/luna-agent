// App shell state: auth, pages, panels, drawer, sidebar geometry. Port of vanilla shell.js + panels.js open/close.
import { nextTick, reactive, ref, watch } from "vue";
import { isDesktop, onUnauthorized, serverUrl, setServerUrl, setToken, token, url } from "@/lib/api";
import { activeAddress, connection, connectionFailure, findWorkingAddress, preferredAddress, recoveryOpen, rememberConnection, reportConnectionFailure } from "@/lib/connections";
import { isMobile } from "@/lib/dom";
import { resolveSettingsRoute } from "@/pages/settings/catalog";
import { sessionPane } from "@/lib/pane";
import * as chatStore from "./chat";
import * as modelsStore from "./models";
import * as sessionsStore from "./sessions";
import * as composerStore from "./composer";

export type View = "chat" | "analytics" | "source-control" | "settings";
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
  boardTarget: null as { projectId: number; cardId: number } | null,
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
function closePage(view: "analytics" | "source-control") {
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
  if (ui.view !== "settings") { closePanel(); closePage("analytics"); closePage("source-control"); ui.view = "settings"; }
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
function openPage(view: "analytics" | "source-control") {
  if (!closeSettings()) return;
  if (ui.login) return;
  closePanel(); setDrawer(false);
  ui.view = view;
  if (location.hash !== "#" + view) location.hash = view;
}
export const openAnalytics = () => openPage("analytics");
export function openBoardCard(projectId: number, cardId: number) {
  if (ui.boardEditing && !window.confirm('Discard unsaved card edits?')) return;
  if (!leavePages()) return;
  ui.boardTarget = { projectId, cardId };
  openPanel('board');
}
export const openSourceControl = () => openPage("source-control");
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
  if (ui.view === "source-control") closePage("source-control");
  return true;
}
export function navigate(view: View, tab?: string) {
  if (view === "settings") openSettings(tab);
  else if (view === "analytics") openAnalytics();
  else if (view === "source-control") openSourceControl();
  else backToChat();
}

// ---- panels ----
let returnFocus: Element | null = null;
export function openPanel(name: string, options?: { keepSettings?: boolean }) {
  if (name === "settings") { closePanel(); return openSettings(); }
  if (name === "analytics") { closePanel(); return openAnalytics(); }
  if (name === "source-control") { closePanel(); return openSourceControl(); }
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
    else if (ui.view === "source-control") document.getElementById("source-control-menu")?.focus();
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
    else document.getElementById(ui.view === "chat" ? "menu" : (ui.view === "source-control" ? "source-control-menu" : ui.view + "-menu"))?.focus();
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
  cancelBoot(); needsBoot = false;
  reportConnectionFailure(bootFailureSource, false);
  routeProbe?.abort(); clearTimeout(routeTimer);
  chatStore.chat.booting = false; chatStore.chat.bootError = "";
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
  needsBoot = true;
  void boot();
}

// Each split tile owns its feeds. Change every tile in the same task, without reloading the shell.
window.addEventListener("luna:can-switch-connection", event => {
  const detail = (event as CustomEvent).detail;
  if (settingsDirty()) detail.error = "Save or discard settings before switching addresses.";
  if (chatStore.sending.value) detail.error = "Wait for the current send to finish before switching addresses.";
  if (detail.prefer && chatStore.busy.value) detail.error = "Wait for the current turn before switching addresses.";
});
window.addEventListener("luna:switch-connection", event => {
  cancelBoot(); needsBoot = true;
  composerStore.saveDraft();
  chatStore.stopFeeds();
  chatStore.chat.connected = false;
  chatStore.chat.bootError = "";
  setServerUrl((event as CustomEvent).detail.target);
  ui.login = false; ui.loginError = "";
  void boot();
});
function connectionWindows(): Window[] {
  // A recovery action in a tile changes the whole workspace, not only that tile.
  const root = sessionPane ? window.parent : window;
  const windows: Window[] = [root];
  for (const frame of root.document.querySelectorAll<HTMLIFrameElement>("iframe[data-tile-session]")) {
    if (frame.contentWindow) windows.push(frame.contentWindow);
  }
  return windows;
}
function canSwitch(target: string, prefer: boolean) {
  const detail = { target, prefer, error: "" };
  for (const pane of connectionWindows()) pane.dispatchEvent(new CustomEvent("luna:can-switch-connection", { detail }));
  return detail;
}
export function changeConnection(target: string, prefer = false) {
  const windows = connectionWindows();
  const detail = canSwitch(target, prefer);
  if (detail.error) throw new Error(detail.error);
  if (!closeSettings()) return;
  // Verify persistence before changing live state. Keep drafts, attachments, and explicit retry IDs in memory.
  localStorage.setItem("luna.server", target);
  for (const pane of windows) pane.dispatchEvent(new CustomEvent("luna:switch-connection", { detail }));
}

// ---- boot and route recovery ----
let bootGeneration = 0, bootDelay = 1000, bootFailures = 0, bootFailureAt = 0;
let needsBoot = true;
let routeNotice = "";
const bootFailureSource = Symbol("boot");
let bootController: AbortController | undefined;
let bootRetry: ReturnType<typeof setTimeout> | undefined;
let badgeTimer: ReturnType<typeof setInterval> | undefined;
let routeProbe: AbortController | undefined;
let routeTimer: ReturnType<typeof setTimeout> | undefined;
function cancelBoot() {
  bootGeneration++; bootController?.abort(); bootController = undefined;
  clearTimeout(bootRetry); bootRetry = undefined;
}
function retryBoot() {
  clearTimeout(bootRetry);
  bootRetry = setTimeout(() => { bootRetry = undefined; void boot(); }, bootDelay);
  bootDelay = Math.min(bootDelay * 2, 15000);
}
export async function boot() {
  if (bootController || ui.login) return;
  clearTimeout(bootRetry); bootRetry = undefined;
  const own = ++bootGeneration, controller = bootController = new AbortController();
  const savedServer = localStorage.getItem("luna.server") || "";
  if (savedServer !== serverUrl.value) setServerUrl(savedServer);
  const chat = chatStore, models = modelsStore, sessions = sessionsStore, composer = composerStore;
  chat.chat.booting = true;
  let remembered: Promise<void> | undefined;
  try {
    // The badge chunk is needed only after boot. Fetch it alongside the health check.
    const badgeModule = import("@/pages/cron/badge");
    badgeModule.catch(() => {});
    if (isDesktop && !serverUrl.value) return showLogin();
    const response = await fetch(url("/health"), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]), cache: "no-store" });
    if (!response.ok) throw Object.assign(new Error("Daemon is not available"), { status: response.status });
    const hl = await response.json();
    if (own !== bootGeneration) return;
    if (hl.auth && !token.value) return showLogin();
    // Remembering addresses is a separate read that never fails. Do not delay the transcript behind it.
    remembered = rememberConnection();
    // The list stream registers before its initial invalidation. Let that event load the list once.
    chat.startListFeed();
    const sessionToOpen = chat.chat.session;
    const sessionOpenTask = sessionToOpen
      ? chat.openSession(sessionToOpen, true)
      : (composer.restoreDraft(), Promise.resolve());
    await Promise.all([
      models.loadModels(),
      sessions.loadProjects(),
      ...(sessionPane ? [sessions.loadSessions()] : []),
      sessionOpenTask,
      remembered,
    ]);
    const badge = await badgeModule;
    if (own !== bootGeneration) return;
    needsBoot = false; bootFailures = 0; bootFailureAt = 0; bootDelay = 1000;
    reportConnectionFailure(bootFailureSource, false); chat.chat.bootError = "";
    if (routeNotice) { chat.addErr(routeNotice, "muted"); routeNotice = ""; }
    void badge.refreshCronBadge();
    badgeTimer ??= setInterval(() => { if (!document.hidden && !ui.login) void badge.refreshCronBadge(); }, 30_000);
    applyHash();
  } catch (e) {
    if (own !== bootGeneration || controller.signal.aborted || ui.login || (e as Error).message === "unauthorized") return;
    if ((e as { status?: number }).status === 401) return showLogin("Token rejected");
    // Route recovery needs the saved addresses that this boot was reading.
    await remembered;
    if (own !== bootGeneration || controller.signal.aborted || ui.login) return;
    needsBoot = true; chat.chat.connected = false;
    chat.chat.bootError = "Reconnecting…";
    bootFailureAt ||= Date.now(); bootFailures++;
    if (bootFailures >= 3 || Date.now() - bootFailureAt >= 8000) reportConnectionFailure(bootFailureSource, true);
    retryBoot();
    // With confirmation disabled, do not wait for the popup debounce to try another route.
    if (connection.value?.prompt === false) void recoverRoute(false);
  } finally {
    if (own === bootGeneration) { chat.chat.booting = false; bootController = undefined; }
  }
}

async function recoverRoute(prefer: boolean) {
  if (sessionPane || ui.login || document.hidden || routeProbe || !connection.value) return;
  if (!prefer && connection.value.prompt) return; // The recovery dialog owns confirmation.
  const index = connection.value.addresses.findIndex(a => a.url === activeAddress());
  const addresses = prefer ? (index < 0 ? [] : connection.value.addresses.slice(0, index)) : connection.value.addresses;
  if (!addresses.length) return;
  const saved = connection.value, origin = serverUrl.value, bearer = token.value;
  const controller = routeProbe = new AbortController();
  try {
    const target = await findWorkingAddress(addresses, controller.signal, prefer);
    if (!target || controller.signal.aborted || connection.value !== saved || serverUrl.value !== origin || token.value !== bearer || ui.login) return;
    if (canSwitch(target, prefer).error) return;
    if (saved.prompt) { preferredAddress.value = target; return; }
    const label = saved.addresses.find(a => a.url === target)?.label || target;
    routeNotice = "Switched to " + label;
    changeConnection(target, prefer);
  } catch { routeNotice = ""; /* Never replay a write on another address. */ }
  finally {
    if (routeProbe === controller) routeProbe = undefined;
    if (!controller.signal.aborted && !document.hidden && !ui.login && (connectionFailure.value || needsBoot) && !connection.value?.prompt) {
      clearTimeout(routeTimer);
      routeTimer = setTimeout(() => { void recoverRoute(false); }, 5000);
    }
  }
}
function resumeConnection() {
  if (ui.login || document.hidden) return;
  if (needsBoot) void boot();
  else void recoverRoute(!connectionFailure.value);
}
// Stores import each other. Install reactive observers after module initialization.
queueMicrotask(() => {
  watch(connectionFailure, failed => { if (failed) void recoverRoute(false); });
  watch(() => [chatStore.busy.value, composerStore.composer.submitting.size, settingsDirty()], () => {
    if (!chatStore.busy.value && !composerStore.composer.submitting.size) resumeConnection();
  });
});
window.addEventListener("online", resumeConnection);
window.addEventListener("focus", resumeConnection);
document.addEventListener("visibilitychange", () => { if (!document.hidden) resumeConnection(); });
window.addEventListener("pagehide", () => { cancelBoot(); routeProbe?.abort(); clearTimeout(routeTimer); });
window.addEventListener("pageshow", e => { if (e.persisted) { needsBoot = true; resumeConnection(); } });

function applyHash() {
  const h = location.hash;
  if (h === "#settings" || h.startsWith("#settings/")) openSettings();
  else if (h === "#analytics") { if (ui.view !== "analytics") openAnalytics(); }
  else if (h === "#source-control") { if (ui.view !== "source-control") openSourceControl(); }
  else if (h === "#github") { history.replaceState(null, "", "#source-control"); if (ui.view !== "source-control") openSourceControl(); }
  else if (h === "#cron") { history.replaceState(null, "", location.pathname + location.search); openPanel("cron"); }
}
window.addEventListener("hashchange", () => {
  const h = location.hash;
  if (h === "#settings" || h.startsWith("#settings/")) { openSettings(); return; }
  if (!closeSettings()) return;
  if (h === "#analytics" || h === "#source-control" || h === "#cron") applyHash();
  else if (h === "#github") { history.replaceState(null, "", "#source-control"); if (ui.view !== "source-control") openSourceControl(); }
  else { closePage("analytics"); closePage("source-control"); }
});
window.addEventListener("beforeunload", e => {
  if (ui.view === "settings" && guard?.isDirty()) { e.preventDefault(); e.returnValue = ""; }
});
