// The only file that imports the terminal emulator. To swap ghostty-web for @xterm/xterm, reimplement createTerm here.
import { FitAddon, init, Terminal } from "ghostty-web";

export interface TermHandle {
  cols: number;
  rows: number;
  /** Raw bytes from the PTY. */
  write(data: Uint8Array): void;
  /** Keystrokes and pastes, as the string the shell expects. */
  onData(listener: (data: string) => void): void;
  onResize(listener: (size: { cols: number; rows: number }) => void): void;
  /** Re-measure the host element and resize the grid to fit. */
  fit(): void;
  focus(): void;
  /** Clear the screen and scrollback before a replay starts. */
  reset(): void;
  dispose(): void;
}

let ready: Promise<void> | undefined;
/** Loads the emulator's WASM once. A failed load can be retried. */
const load = () => (ready ??= init().catch(e => { ready = undefined; throw e; }));

const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

export async function createTerm(host: HTMLElement, options: { fontSize: number }): Promise<TermHandle> {
  await load();
  const term = new Terminal({
    cursorBlink: true,
    fontSize: options.fontSize,
    fontFamily: css("--mono", "ui-monospace, monospace"),
    scrollback: 10_000,
    theme: { background: css("--background", "#121212"), foreground: css("--foreground", "#ececec"), cursor: css("--primary-text", "#e86060") },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();
  const resizeListeners: ((size: { cols: number; rows: number }) => void)[] = [];
  term.onResize(size => { for (const l of resizeListeners) l(size); });
  return {
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    write: data => term.write(data),
    onData: listener => { term.onData(listener); },
    onResize: listener => { resizeListeners.push(listener); },
    fit: () => fit.fit(),
    focus: () => term.focus(),
    reset: () => term.reset(),
    dispose: () => { resizeListeners.length = 0; fit.dispose(); term.dispose(); },
  };
}
