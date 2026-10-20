// The existing chat stores are document-local. A same-origin frame gives each pane
// its own feeds, composer, models, dialogs, and DOM IDs without global state swaps.
export const sessionPane = window !== window.top && new URLSearchParams(location.search).get("pane") === "session";
const sessionKey = sessionPane ? "luna.split.session" : "luna.session";
export const draftsKey = sessionPane ? "luna.split.drafts" : "luna.drafts";

export function savedSession(): string | null {
  return sessionStorage.getItem(sessionKey) || (sessionPane ? null : localStorage.getItem(sessionKey));
}
export function rememberSession(id: string | null) {
  if (id) sessionStorage.setItem(sessionKey, id);
  else sessionStorage.removeItem(sessionKey);
  // The second pane must never replace the workspace's last selected session.
  if (!sessionPane) {
    if (id) localStorage.setItem(sessionKey, id);
    else localStorage.removeItem(sessionKey);
  }
}
