// Native desktop features. Every call is a no-op in the browser build.
import { isDesktop } from "./api";

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
const invoke = (): Invoke | undefined => (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__?.invoke;

/** Show a system notification. */
export function notify(title: string, body: string) {
  if (!isDesktop) return;
  void invoke()?.("notify", { title, body })?.catch(() => {});
}
