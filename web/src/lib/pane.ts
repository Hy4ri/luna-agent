// Chat stores stay document-local. Each additional tile owns one fixed session,
// with its own feeds, composer, models, dialogs, and DOM IDs.
import { ref } from "vue";

const params = new URLSearchParams(location.search);
export const sessionPane = window !== window.top && params.get("pane") === "session";
export const paneSession = sessionPane ? params.get("session") : null;
export const sessionDragType = "application/x-luna-session";
export const draggedSession = ref<string | null>(null);
// Read the old draft map only for migration. New writes use one key per session,
// so one document cannot overwrite another document's saved text.
export const draftsKey = sessionPane ? "luna.split.drafts" : "luna.drafts";

export function startSessionDrag(event: DragEvent, id: string | number) {
  if (!event.dataTransfer) return;
  event.dataTransfer.setData(sessionDragType, String(id));
  event.dataTransfer.effectAllowed = "copy";
  draggedSession.value = String(id);
}
export function endSessionDrag() { draggedSession.value = null; }

let sessionRouter: ((id: string) => boolean) | undefined;
export function setSessionRouter(router?: (id: string) => boolean) { sessionRouter = router; }
/** Returns true when the workspace, rather than this document, handles navigation. */
export function routeSession(id: string): boolean {
  if (sessionPane && id !== paneSession) {
    window.parent.postMessage({ type: "luna:open-session", session: id }, location.origin);
    return true;
  }
  return sessionRouter?.(id) ?? false;
}
export function closeSessionPane() {
  if (sessionPane) window.parent.postMessage({ type: "luna:close-tile" }, location.origin);
}
export function savedSession(): string | null {
  if (sessionPane) return paneSession;
  return sessionStorage.getItem("luna.session") || localStorage.getItem("luna.session");
}
export function rememberSession(id: string | null) {
  // Tile navigation must never replace the workspace's selected session.
  if (sessionPane) { if (!id) closeSessionPane(); return; }
  for (const storage of [sessionStorage, localStorage]) {
    if (id) storage.setItem("luna.session", id);
    else storage.removeItem("luna.session");
  }
}

// HTTP/1 browsers allow six connections per origin. A list SSE per tile plus
// three session SSEs would exhaust all six and deadlock sends/model changes.
export function notifySessionPanes(event: "sessions_changed" | "board_changed") {
  for (const frame of document.querySelectorAll<HTMLIFrameElement>('iframe[data-tile-session]')) {
    frame.contentWindow?.postMessage({ type: "luna:workspace-event", event }, location.origin);
  }
}
