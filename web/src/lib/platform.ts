// Native desktop features. Every call is a no-op in the browser build.
import { isDesktop } from "./api";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
const invoke = (): Invoke | undefined => (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__?.invoke;

/** Show a system notification. */
export function notify(title: string, body: string) {
  if (!isDesktop) return;
  void invoke()?.("notify", { title, body })?.catch(() => {});
}

/** Tauri blocks target=_blank. Send http(s) links to the system browser instead. */
export function installExternalLinks() {
  if (!isDesktop) return;
  document.addEventListener("click", e => {
    const a = (e.target as Element | null)?.closest?.("a[target=_blank]") as HTMLAnchorElement | null;
    if (!a || !/^https?:\/\//i.test(a.href) || a.href.startsWith(location.origin)) return;
    e.preventDefault();
    void invoke()?.("plugin:opener|open_url", { url: a.href })?.catch(() => {});
  });
}
