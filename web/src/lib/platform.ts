// Native desktop and Android features. Every call is a no-op or a browser fallback in the browser build.
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

/** The Android APK. Its WebView ignores `<a download>`, so files save through the native shell. */
const isAndroid = isDesktop && /Android/i.test(navigator.userAgent);

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file"));
    reader.readAsDataURL(blob);
  });
}

/** Save a file to the device: the Downloads folder on Android, a browser download elsewhere. */
export async function saveFile(blob: Blob, name: string) {
  const filename = name || "download";
  const native = invoke();
  if (isAndroid && native) {
    await native("save_download", { name: filename, mime: blob.type, data: await base64(blob) });
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
