// Headless terminal screen for terminals Luna reads, built on the signed libghostty-vt 1.0.0 C ABI WASM.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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

const WASM_URL = new URL("ghostty-vt-1.0.0-small.wasm", import.meta.url);
// Signed by RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV (https://release.files.ghostty.org/libghostty-vt/1.0.0/).
export const WASM_SHA256 = "dad8e14ce8da57db3864f66ae36caf66a17c4e2691ad0a0110e05c746de047a4";
const SCROLLBACK_LINES = 2000;
const SCROLLBACK_BYTES = 10 * 1024 * 1024;
const DEFAULT_FG = 0xffffff;
const DEFAULT_BG = 0x000000;
const INVERSE = 1 << 4;

// libghostty-vt 1.0 C ABI constants (wasm32-freestanding).
const OPT_WRITE_PTY = 2, OPT_SCROLLBACK_MAX_BYTES = 28, OPT_SCROLLBACK_MAX_LINES = 29, OPT_MODE = 35;
const DATA_COLS = 1, DATA_ROWS = 2, DATA_CURSOR_X = 3, DATA_CURSOR_Y = 4, DATA_ACTIVE_SCREEN = 6,
  DATA_CURSOR_VISIBLE = 7, DATA_SCROLLBACK_ROWS = 15, DATA_MODE = 37;
const RS_ROW_ITERATOR = 4, RS_COLOR_BG = 5, RS_COLOR_FG = 6;
const ROW_CELLS = 3;
const CELLS_RAW = 1, CELLS_STYLE = 2, CELLS_GRAPHEMES_BUF = 4, CELLS_BG_COLOR = 5, CELLS_FG_COLOR = 6;
const POINT_HISTORY = 3;
const WIDE_SPACER_TAIL = 2, WIDE_SPACER_HEAD = 3;

// Tiny 35-byte WASM module that wraps a JS `(i32, i32, i32, i32) -> void` function so it can be placed in
// `__indirect_function_table` and passed as a C function pointer to `GHOSTTY_TERMINAL_OPT_WRITE_PTY`.
const WRITE_PTY_TRAMPOLINE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x08, 0x01, 0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x00,
  0x02, 0x07, 0x01, 0x01, 0x65, 0x01, 0x66, 0x00, 0x00,
  0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00,
]);

interface Exports {
  memory: { buffer: ArrayBuffer };
  __indirect_function_table: { grow(n: number): number; set(i: number, fn: unknown): void };
  ghostty_wasm_alloc(len: number): number;
  ghostty_wasm_free(ptr: number, len: number): void;
  ghostty_wasm_alloc_opaque(): number;
  ghostty_wasm_take_opaque(slot: number): number;
  ghostty_terminal_new(alloc: number, slot: number, cols: number, rows: number): number;
  ghostty_terminal_free(term: number): void;
  ghostty_terminal_resize(term: number, cols: number, rows: number, cellW: number, cellH: number): number;
  ghostty_terminal_set(term: number, opt: number, valPtr: number): number;
  ghostty_terminal_get(term: number, data: number, outPtr: number): number;
  ghostty_terminal_vt_write(term: number, ptr: number, len: number): void;
  ghostty_terminal_grid_ref(term: number, pointPtr: number, refPtr: number): number;
  ghostty_grid_ref_cell(refPtr: number, cellPtr: number): number;
  ghostty_grid_ref_graphemes(refPtr: number, bufPtr: number, cap: number, writtenPtr: number): number;
  ghostty_render_state_new(alloc: number, slot: number): number;
  ghostty_render_state_free(rs: number): void;
  ghostty_render_state_update(rs: number, term: number): number;
  ghostty_render_state_get(rs: number, data: number, outPtr: number): number;
  ghostty_render_state_row_iterator_new(alloc: number, slot: number): number;
  ghostty_render_state_row_iterator_free(it: number): void;
  ghostty_render_state_row_iterator_next(it: number): number;
  ghostty_render_state_row_get(it: number, data: number, outPtr: number): number;
  ghostty_render_state_row_cells_new(alloc: number, slot: number): number;
  ghostty_render_state_row_cells_free(cells: number): void;
  ghostty_render_state_row_cells_next(cells: number): number;
  ghostty_render_state_row_cells_get(cells: number, data: number, outPtr: number): number;
}

type Wasm = {
  compile(b: Uint8Array): Promise<unknown>;
  instantiate(m: unknown, i: object): Promise<{ exports: unknown }>;
};
// The project's lib has no WebAssembly types; Node has the global.
const wasm = () => (globalThis as unknown as { WebAssembly: Wasm }).WebAssembly;

interface Runtime {
  e: Exports;
  writePtyFn: number;
  replies: Map<number, string>;
  slot: number;
  scratch: number;
  cpBuf: number;
  cpCap: number;
  writeBuf: number;
  writeCap: number;
  mem(): DataView;
  bytes(): Uint8Array;
  ensureCp(cap: number): number;
  ensureWrite(len: number): number;
  readGraphemes(ptr: number, count: number): string;
}

let runtime: Promise<Runtime> | undefined;

function getRuntime(): Promise<Runtime> {
  return runtime ??= (async () => {
    const raw = readFileSync(WASM_URL);
    const digest = createHash("sha256").update(raw).digest("hex");
    if (digest !== WASM_SHA256)
      throw new Error(`ghostty-vt WASM SHA256 mismatch: expected ${WASM_SHA256}, got ${digest}`);
    const [vtMod, trampMod] = await Promise.all([wasm().compile(raw), wasm().compile(WRITE_PTY_TRAMPOLINE)]);
    const replies = new Map<number, string>();
    const decoder = new TextDecoder();
    let e!: Exports;
    const tramp = await wasm().instantiate(trampMod, {
      e: {
        f: (term: number, _ud: number, ptr: number, len: number) => {
          if (len <= 0) return;
          const chunk = decoder.decode(new Uint8Array(e.memory.buffer, ptr, len));
          replies.set(term, (replies.get(term) ?? "") + chunk);
        },
      },
    });
    e = (await wasm().instantiate(vtMod, {})).exports as Exports;
    const writePtyFn = e.__indirect_function_table.grow(1);
    e.__indirect_function_table.set(writePtyFn, (tramp.exports as { f: unknown }).f);
    // Shared scratch layout (128 bytes, 8-byte aligned):
    //   0..23:  GhosttyPoint (24B) / general scratch
    //   24..31: GhosttyGridRef (8B)
    //   32..39: GhosttyCell (8B)
    //   40..55: GhosttyStyle (16B)
    //   56..67: GhosttyCodepointBuffer (12B: ptr, cap, len)
    //   68..71: RGB / u32 / pointer box (4B)
    //   72..75: default RGB / out_written (4B)
    const slot = e.ghostty_wasm_alloc_opaque();
    const scratch = e.ghostty_wasm_alloc(128);
    let cpCap = 32, cpBuf = e.ghostty_wasm_alloc(cpCap * 4);
    let writeCap = 16384, writeBuf = e.ghostty_wasm_alloc(writeCap);
    let cachedBuf: ArrayBuffer | undefined, cachedView: DataView | undefined, cachedBytes: Uint8Array | undefined;
    const sync = () => {
      if (cachedBuf !== e.memory.buffer) {
        cachedBuf = e.memory.buffer;
        cachedView = new DataView(cachedBuf);
        cachedBytes = new Uint8Array(cachedBuf);
      }
    };
    return {
      e, writePtyFn, replies, slot, scratch,
      get cpBuf() { return cpBuf; },
      get cpCap() { return cpCap; },
      get writeBuf() { return writeBuf; },
      get writeCap() { return writeCap; },
      mem: () => (sync(), cachedView!),
      bytes: () => (sync(), cachedBytes!),
      ensureCp(cap: number) {
        if (cap > cpCap) {
          e.ghostty_wasm_free(cpBuf, cpCap * 4);
          cpCap = Math.max(cap, cpCap * 2);
          cpBuf = e.ghostty_wasm_alloc(cpCap * 4);
        }
        return cpBuf;
      },
      ensureWrite(len: number) {
        if (len > writeCap) {
          e.ghostty_wasm_free(writeBuf, writeCap);
          writeCap = Math.max(len, writeCap * 2);
          writeBuf = e.ghostty_wasm_alloc(writeCap);
        }
        return writeBuf;
      },
      readGraphemes(ptr: number, count: number) {
        const dv = (sync(), cachedView!);
        let s = "";
        for (let i = 0; i < count; i++) s += String.fromCodePoint(dv.getUint32(ptr + i * 4, true));
        return s;
      },
    };
  })().catch(err => { runtime = undefined; throw err; });
}

export async function loadVt(): Promise<VtFactory> {
  const rt = await getRuntime();
  return async (cols, rows) => {
    const { e, scratch, slot } = rt;
    if (e.ghostty_terminal_new(0, slot, cols, rows) !== 0) throw new Error("ghostty_terminal_new failed");
    const term = e.ghostty_wasm_take_opaque(slot);
    if (e.ghostty_render_state_new(0, slot) !== 0) {
      e.ghostty_terminal_free(term);
      throw new Error("ghostty_render_state_new failed");
    }
    const rs = e.ghostty_wasm_take_opaque(slot);
    if (e.ghostty_render_state_row_iterator_new(0, slot) !== 0) {
      e.ghostty_render_state_free(rs); e.ghostty_terminal_free(term);
      throw new Error("ghostty_render_state_row_iterator_new failed");
    }
    const rowIt = e.ghostty_wasm_take_opaque(slot);
    if (e.ghostty_render_state_row_cells_new(0, slot) !== 0) {
      e.ghostty_render_state_row_iterator_free(rowIt); e.ghostty_render_state_free(rs); e.ghostty_terminal_free(term);
      throw new Error("ghostty_render_state_row_cells_new failed");
    }
    const rowCells = e.ghostty_wasm_take_opaque(slot);

    rt.mem().setUint32(scratch, SCROLLBACK_BYTES, true);
    e.ghostty_terminal_set(term, OPT_SCROLLBACK_MAX_BYTES, scratch);
    rt.mem().setUint32(scratch, SCROLLBACK_LINES, true);
    e.ghostty_terminal_set(term, OPT_SCROLLBACK_MAX_LINES, scratch);
    // Enable DEC mode 2027 (grapheme cluster segmentation) by default to match ghostty-web's clustering of ZWJ emoji.
    rt.mem().setUint16(scratch, 2027, true);
    rt.mem().setUint8(scratch + 2, 1);
    e.ghostty_terminal_set(term, OPT_MODE, scratch);
    e.ghostty_terminal_set(term, OPT_WRITE_PTY, rt.writePtyFn);

    let freed = false;
    return {
      write: data => {
        if (freed || !data.length) return;
        const ptr = rt.ensureWrite(data.length);
        rt.bytes().set(data, ptr);
        e.ghostty_terminal_vt_write(term, ptr, data.length);
      },
      resize: (c, r) => {
        if (!freed) e.ghostty_terminal_resize(term, c, r, 0, 0);
      },
      screen: () => {
        const cellPtr = scratch + 32, stylePtr = scratch + 40,
          cpBufStruct = scratch + 56, boxPtr = scratch + 68, rgbPtr = scratch + 72;
        e.ghostty_terminal_get(term, DATA_COLS, boxPtr);
        const curCols = rt.mem().getUint16(boxPtr, true);
        e.ghostty_terminal_get(term, DATA_ROWS, boxPtr);
        const curRows = rt.mem().getUint16(boxPtr, true);
        e.ghostty_terminal_get(term, DATA_CURSOR_X, boxPtr);
        const cx = rt.mem().getUint16(boxPtr, true);
        e.ghostty_terminal_get(term, DATA_CURSOR_Y, boxPtr);
        const cy = rt.mem().getUint16(boxPtr, true);
        e.ghostty_terminal_get(term, DATA_CURSOR_VISIBLE, boxPtr);
        const cvis = rt.mem().getUint8(boxPtr) !== 0;
        e.ghostty_terminal_get(term, DATA_ACTIVE_SCREEN, boxPtr);
        const alternate = rt.mem().getInt32(boxPtr, true) === 1;

        e.ghostty_render_state_update(rs, term);
        const defBg = e.ghostty_render_state_get(rs, RS_COLOR_BG, rgbPtr) === 0
          ? (rt.bytes()[rgbPtr]! << 16) | (rt.bytes()[rgbPtr + 1]! << 8) | rt.bytes()[rgbPtr + 2]! : DEFAULT_BG;
        const defFg = e.ghostty_render_state_get(rs, RS_COLOR_FG, rgbPtr) === 0
          ? (rt.bytes()[rgbPtr]! << 16) | (rt.bytes()[rgbPtr + 1]! << 8) | rt.bytes()[rgbPtr + 2]! : DEFAULT_FG;

        rt.mem().setUint32(boxPtr, rowIt, true);
        e.ghostty_render_state_get(rs, RS_ROW_ITERATOR, boxPtr);
        const lines: string[] = [], grid: { ch: string[]; bg: number[] }[] = [];
        while (e.ghostty_render_state_row_iterator_next(rowIt)) {
          rt.mem().setUint32(boxPtr, rowCells, true);
          e.ghostty_render_state_row_get(rowIt, ROW_CELLS, boxPtr);
          const ch: string[] = [], bg: number[] = [];
          while (e.ghostty_render_state_row_cells_next(rowCells)) {
            e.ghostty_render_state_row_cells_get(rowCells, CELLS_RAW, cellPtr);
            const rawCell = rt.mem().getBigUint64(cellPtr, true);
            const wide = Number((rawCell >> 42n) & 3n);
            if (wide === WIDE_SPACER_TAIL) ch.push("");
            else if (wide === WIDE_SPACER_HEAD) ch.push(" ");
            else {
              rt.mem().setUint32(cpBufStruct, rt.cpBuf, true);
              rt.mem().setUint32(cpBufStruct + 4, rt.cpCap, true);
              let gr = e.ghostty_render_state_row_cells_get(rowCells, CELLS_GRAPHEMES_BUF, cpBufStruct);
              const len = rt.mem().getUint32(cpBufStruct + 8, true);
              if (gr !== 0 && len > rt.cpCap) {
                const ptr = rt.ensureCp(len);
                rt.mem().setUint32(cpBufStruct, ptr, true);
                rt.mem().setUint32(cpBufStruct + 4, rt.cpCap, true);
                gr = e.ghostty_render_state_row_cells_get(rowCells, CELLS_GRAPHEMES_BUF, cpBufStruct);
              }
              const cp0 = len > 0 ? rt.mem().getUint32(rt.cpBuf, true) : 0;
              ch.push(len === 0 || cp0 === 0 ? " " : rt.readGraphemes(rt.cpBuf, len));
            }
            e.ghostty_render_state_row_cells_get(rowCells, CELLS_STYLE, stylePtr);
            const inv = (rt.mem().getUint16(stylePtr + 12, true) & INVERSE) !== 0;
            const cr = e.ghostty_render_state_row_cells_get(rowCells, inv ? CELLS_FG_COLOR : CELLS_BG_COLOR, rgbPtr);
            const b = rt.bytes();
            bg.push(cr === 0 ? (b[rgbPtr]! << 16) | (b[rgbPtr + 1]! << 8) | b[rgbPtr + 2]! : (inv ? defFg : defBg));
          }
          lines.push(ch.join("").trimEnd());
          grid.push({ ch, bg });
        }
        while (lines.length < curRows) { lines.push(""); grid.push({ ch: [], bg: [] }); }
        return { cols: curCols, rows: curRows, lines, cursor: { row: cy, col: cx, visible: cvis }, alternate, grid };
      },
      scrollback: count => {
        if (freed || count <= 0) return [];
        const ptPtr = scratch, refPtr = scratch + 24, cellPtr = scratch + 32, boxPtr = scratch + 68, writtenPtr = scratch + 72;
        e.ghostty_terminal_get(term, DATA_SCROLLBACK_ROWS, boxPtr);
        const total = rt.mem().getUint32(boxPtr, true);
        e.ghostty_terminal_get(term, DATA_COLS, boxPtr);
        const curCols = rt.mem().getUint16(boxPtr, true);
        const out: string[] = [];
        for (let y = Math.max(0, total - count); y < total; y++) {
          let s = "";
          for (let x = 0; x < curCols; x++) {
            rt.mem().setInt32(ptPtr, POINT_HISTORY, true);
            rt.mem().setUint16(ptPtr + 8, x, true);
            rt.mem().setUint32(ptPtr + 12, y, true);
            if (e.ghostty_terminal_grid_ref(term, ptPtr, refPtr) !== 0) { s += " "; continue; }
            e.ghostty_grid_ref_cell(refPtr, cellPtr);
            const wide = Number((rt.mem().getBigUint64(cellPtr, true) >> 42n) & 3n);
            if (wide === WIDE_SPACER_TAIL) continue;
            if (wide === WIDE_SPACER_HEAD) { s += " "; continue; }
            let gr = e.ghostty_grid_ref_graphemes(refPtr, rt.cpBuf, rt.cpCap, writtenPtr);
            const len = rt.mem().getUint32(writtenPtr, true);
            if (gr !== 0 && len > rt.cpCap) {
              gr = e.ghostty_grid_ref_graphemes(refPtr, rt.ensureCp(len), rt.cpCap, writtenPtr);
            }
            const cp0 = len > 0 ? rt.mem().getUint32(rt.cpBuf, true) : 0;
            s += len === 0 || cp0 === 0 ? " " : rt.readGraphemes(rt.cpBuf, len);
          }
          out.push(s.trimEnd());
        }
        return out;
      },
      mode: m => {
        if (freed) return false;
        rt.mem().setUint16(scratch, m & 0x7fff, true);
        rt.mem().setUint8(scratch + 2, 0);
        return e.ghostty_terminal_get(term, DATA_MODE, scratch) === 0 && rt.mem().getUint8(scratch + 2) !== 0;
      },
      responses: () => {
        if (freed) return "";
        const out = rt.replies.get(term) ?? "";
        rt.replies.delete(term);
        return out;
      },
      dispose: () => {
        if (freed) return;
        freed = true;
        rt.replies.delete(term);
        e.ghostty_render_state_row_cells_free(rowCells);
        e.ghostty_render_state_row_iterator_free(rowIt);
        e.ghostty_render_state_free(rs);
        e.ghostty_terminal_free(term);
      },
    };
  };
}
