// The DOM adapter is lazy-loaded; the official ABI core is shared with the agent terminal.
import { createVtRuntime, type VtRuntime } from "../../../src/terminal/vt-core";
import wasmUrl from "../../../src/terminal/ghostty-vt-1.0.1-small.wasm?url";
import { TermCanvas } from "./term-canvas";
import { TermInput } from "./term-input";

export interface TermHandle {
  cols: number;
  rows: number;
  write(data: Uint8Array): void;
  /** Human input only. Protocol replies must not pass through sticky modifier keys. */
  onData(listener: (data: string) => void): void;
  onResponse(listener: (data: string) => void): void;
  onResize(listener: (size: { cols: number; rows: number }) => void): void;
  fit(): void;
  focus(): void;
  reset(): void;
  dispose(): void;
}

let ready: Promise<VtRuntime> | undefined;
/** Use the bundled signed release, never a runtime CDN. A failed load can be retried. */
const load = () => ready ??= (async () => {
  const res = await fetch(wasmUrl);
  if (!res.ok) throw new Error(`Terminal WASM: HTTP ${res.status}`);
  return createVtRuntime(new Uint8Array(await res.arrayBuffer()));
})().catch(error => { ready = undefined; throw error; });
const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

function color(value: string, fallback: number): number {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return fallback;
  ctx.fillStyle = `#${fallback.toString(16).padStart(6, "0")}`;
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
  return (r << 16) | (g << 8) | b;
}

export async function createTerm(host: HTMLElement, options: { fontSize: number }): Promise<TermHandle> {
  const runtime = await load();
  let cols = 80, rows = 24, disposed = false, animation = 0, force = true;
  let term = runtime.create(cols, rows, { scrollbackLines: 10_000, scrollbackBytes: 32 * 1024 * 1024 });
  const canvas = new TermCanvas();
  const dataListeners: ((data: string) => void)[] = [];
  const responseListeners: ((data: string) => void)[] = [];
  const resizeListeners: ((size: { cols: number; rows: number }) => void)[] = [];
  const send = (data: string) => { if (data && !disposed) for (const listener of dataListeners) listener(data); };
  const draw = () => {
    animation = 0;
    if (disposed) return;
    canvas.draw(term.frame(force));
    force = false;
  };
  const schedule = () => { if (!disposed && !animation) animation = requestAnimationFrame(draw); };
  const input = new TermInput(canvas, () => term, send, schedule);
  const configure = () => {
    const theme = {
      fg: color(css("--foreground", "#ececec"), 0xececec),
      bg: color(css("--background", "#121212"), 0x121212),
      cursor: color(css("--primary-text", "#e86060"), 0xe86060),
      selection: css("--muted", "rgba(128,128,128,.4)"),
    };
    canvas.configure(css("--mono", "ui-monospace, monospace"), options.fontSize, theme);
    term.setTheme(theme.fg, theme.bg, theme.cursor);
  };
  const fit = () => {
    if (disposed) return;
    const style = getComputedStyle(host);
    const width = host.clientWidth - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0");
    const height = host.clientHeight - parseFloat(style.paddingTop || "0") - parseFloat(style.paddingBottom || "0");
    if (width <= 0 || height <= 0) return;
    const nextCols = Math.max(2, Math.floor(width / canvas.width)), nextRows = Math.max(1, Math.floor(height / canvas.height));
    if (canvas.resize(width, height)) force = true;
    if (nextCols !== cols || nextRows !== rows) {
      cols = nextCols; rows = nextRows;
      term.resize(cols, rows);
      input.clearSelection();
      force = true;
      for (const listener of resizeListeners) listener({ cols, rows });
    }
    schedule();
  };
  try {
    host.append(canvas.element);
    configure();
    fit();
  } catch (error) { input.dispose(); canvas.element.remove(); term.dispose(); throw error; }
  const themeObserver = new MutationObserver(() => { configure(); force = true; fit(); schedule(); });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  const events = new AbortController();
  // DPR can change without a ResizeObserver event (moving a window between displays).
  window.addEventListener("resize", fit, { signal: events.signal });
  document.fonts?.addEventListener("loadingdone", () => { configure(); force = true; fit(); }, { signal: events.signal });
  const blink = setInterval(() => { if (!disposed) canvas.tick(); }, 530);
  return {
    get cols() { return cols; }, get rows() { return rows; },
    write(data) {
      if (disposed) return;
      term.write(data);
      const response = term.responses();
      if (response) for (const listener of responseListeners) listener(response);
      schedule();
    },
    onData: listener => { dataListeners.push(listener); },
    onResponse: listener => { responseListeners.push(listener); },
    onResize: listener => { resizeListeners.push(listener); },
    fit,
    focus: () => { if (!disposed) input.focus(); },
    reset() {
      if (disposed) return;
      input.clearSelection();
      const replacement = runtime.create(cols, rows, { scrollbackLines: 10_000, scrollbackBytes: 32 * 1024 * 1024 });
      term.dispose(); term = replacement;
      configure(); force = true; schedule();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      events.abort(); themeObserver.disconnect(); clearInterval(blink); cancelAnimationFrame(animation);
      input.dispose(); canvas.element.remove(); term.dispose();
      dataListeners.length = responseListeners.length = resizeListeners.length = 0;
    },
  };
}
