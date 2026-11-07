// Headless terminal screen for terminals Luna reads. It uses the same libghostty-vt parser as the browser, so the screen
// Luna sees matches the screen m57 sees. ghostty-web is a 0.x API: only this file may import it.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Ghostty, type GhosttyTerminal } from "ghostty-web";

export interface VtScreen {
  cols: number;
  rows: number;
  /** One string per row, trailing blanks removed. */
  lines: string[];
  /** 0-based cell position of the cursor. */
  cursor: { row: number; col: number; visible: boolean };
  /** Full-screen programs (vim, htop, less) draw on the alternate screen. */
  alternate: boolean;
  /**
   * Per cell, by column: the character ("" for the right half of a wide character) and the effective background as
   * 0xRRGGBB (inverse video swaps in the foreground). Menus and lists show the selected item this way.
   */
  grid?: { ch: string[]; bg: number[] }[];
}

export interface VtModel {
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  screen(): VtScreen;
  /** The last `count` scrollback lines, oldest first. */
  scrollback(count: number): string[];
  /** DEC private mode, e.g. 1 (application cursor keys) or 2004 (bracketed paste). */
  mode(mode: number): boolean;
  /** Replies the program asked for, such as a cursor position report. Empty when there are none. */
  responses(): string;
  dispose(): void;
}

export type VtFactory = (cols: number, rows: number) => Promise<VtModel>;

const SCROLLBACK_LINES = 2000;
type Wasm = { compile(b: Uint8Array): Promise<unknown>; instantiate(m: unknown, i: object): Promise<unknown> };
// The project's lib has no WebAssembly types; Node has the global.
const wasm = () => (globalThis as unknown as { WebAssembly: Wasm }).WebAssembly;
let compiled: Promise<unknown> | undefined;

/** Compile the WASM parser once per process. A failed compile can be retried. */
function module(): Promise<unknown> {
  return compiled ??= (async () => {
    const path = createRequire(import.meta.url).resolve("ghostty-web/ghostty-vt.wasm");
    return wasm().compile(readFileSync(path));
  })().catch(e => { compiled = undefined; throw e; });
}

// One WASM instance per terminal. ghostty-web 0.4.0 corrupts a terminal created in an instance after another terminal
// there was freed (its cells read stale memory). A private instance is small and is dropped with its terminal.
async function instance(): Promise<Ghostty> {
  const i = await wasm().instantiate(await module(), { env: { log: () => {} } });
  return new Ghostty(i as ConstructorParameters<typeof Ghostty>[0]);
}

type Line = NonNullable<ReturnType<GhosttyTerminal["getLine"]>>;
const INVERSE = 16;
function cells(line: Line, grapheme: (col: number) => string): { ch: string[]; bg: number[] } {
  const ch: string[] = [], bg: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const c = line[x]!;
    ch.push(c.width === 0 ? "" : !c.codepoint ? " " : c.grapheme_len ? grapheme(x) : String.fromCodePoint(c.codepoint));
    bg.push(c.flags & INVERSE ? (c.fg_r << 16) | (c.fg_g << 8) | c.fg_b : (c.bg_r << 16) | (c.bg_g << 8) | c.bg_b);
  }
  return { ch, bg };
}
function text(line: Line, grapheme: (col: number) => string): string {
  let s = "";
  for (let x = 0; x < line.length; x++) {
    const cell = line[x]!;
    if (cell.width === 0) continue; // right half of a wide character
    s += !cell.codepoint ? " " : cell.grapheme_len ? grapheme(x) : String.fromCodePoint(cell.codepoint);
  }
  return s.trimEnd();
}

/** The factory is async per terminal, because each terminal gets its own instance. */
export async function loadVt(): Promise<VtFactory> {
  await module();
  return async (cols, rows) => {
    const t = (await instance()).createTerminal(cols, rows, { scrollbackLimit: SCROLLBACK_LINES });
    let freed = false;
    return {
      // ghostty-web 0.4.0 throws on an empty write; sharing a terminal before its first output replays an empty ring.
      write: data => { if (!freed && data.length) t.write(data); },
      resize: (c, r) => { if (!freed) t.resize(c, r); },
      screen: () => {
        const lines: string[] = [], grid: { ch: string[]; bg: number[] }[] = [];
        for (let y = 0; y < t.rows; y++) {
          const l = t.getLine(y);
          if (!l) { lines.push(""); grid.push({ ch: [], bg: [] }); continue; }
          const row = cells(l, x => t.getGraphemeString(y, x));
          lines.push(row.ch.join("").trimEnd());
          grid.push(row);
        }
        const c = t.getCursor();
        return { cols: t.cols, rows: t.rows, lines, cursor: { row: c.y, col: c.x, visible: !!c.visible }, alternate: t.isAlternateScreen(), grid };
      },
      scrollback: count => {
        const total = t.getScrollbackLength(), out: string[] = [];
        for (let i = Math.max(0, total - count); i < total; i++) { const l = t.getScrollbackLine(i); out.push(l ? text(l, x => t.getScrollbackGraphemeString(i, x)) : ""); }
        return out;
      },
      mode: m => !freed && t.getMode(m, false),
      responses: () => {
        let out = "";
        while (!freed && t.hasResponse()) { const r = t.readResponse(); if (!r) break; out += r; }
        return out;
      },
      dispose: () => { if (!freed) { freed = true; t.free(); } },
    };
  };
}
