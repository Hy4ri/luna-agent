// Environment-neutral libghostty-vt 1.0.1 C ABI runtime and terminal core.
import { domKeyToGhosttyKey } from "./vt-input.js";

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

export interface VtCell {
  text: string;
  width: number;
  fg: number;
  bg: number;
  flags: number;
  underline: number;
}

export interface VtFrame {
  cols: number;
  rows: number;
  cursor: { row: number; col: number; visible: boolean; style: number };
  lines: { row: number; cells: VtCell[]; selection?: { start: number; end: number } }[];
  alternate: boolean;
  scrollback: number;
  scrollOffset: number;
}

export interface VtTerminalOptions {
  scrollbackLines?: number;
  scrollbackBytes?: number;
}

export interface VtKeyEvent {
  key: string;
  code: string;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

export interface VtMouseEvent {
  action: "press" | "release" | "motion";
  button: number;
  x: number;
  y: number;
  mods: number;
  cellWidth: number;
  cellHeight: number;
  buttons: number;
}

export interface VtTerminal {
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
  frame(force?: boolean): VtFrame;
  setTheme(fg: number, bg: number, cursor: number): void;
  scroll(delta: number): void;
  scrollToBottom(): void;
  select(start: { col: number; row: number }, end: { col: number; row: number }): void;
  clearSelection(): void;
  selectionText(): string;
  key(event: VtKeyEvent): string;
  mouse(event: VtMouseEvent): string;
  paste(text: string): string;
}

export interface VtRuntime {
  create(cols: number, rows: number, options?: VtTerminalOptions): VtTerminal;
}

export const WASM_SHA256 = "e226900d2126faab515668e5400b69fc78ba3d99aaf9525b325f79707b29bf01";
const DEFAULT_SCROLLBACK_LINES = 2000;
const DEFAULT_SCROLLBACK_BYTES = 10 * 1024 * 1024;
const DEFAULT_FG = 0xffffff;
const DEFAULT_BG = 0x000000;
const INVERSE = 1 << 4;

// libghostty-vt 1.0.1 C ABI constants (wasm32-freestanding).
const OPT_WRITE_PTY = 2,
  OPT_COLOR_FOREGROUND = 12,
  OPT_COLOR_BACKGROUND = 13,
  OPT_COLOR_CURSOR = 14,
  OPT_SELECTION = 22,
  OPT_SCROLLBACK_MAX_BYTES = 28,
  OPT_SCROLLBACK_MAX_LINES = 29,
  OPT_MODE = 35;

const DATA_COLS = 1,
  DATA_ROWS = 2,
  DATA_CURSOR_X = 3,
  DATA_CURSOR_Y = 4,
  DATA_ACTIVE_SCREEN = 6,
  DATA_CURSOR_VISIBLE = 7,
  DATA_SCROLLBAR = 9,
  DATA_SCROLLBACK_ROWS = 15,
  DATA_SELECTION = 31,
  DATA_MODE = 37;

const FORMATTER_OPT_SELECTION = 4;

const RS_DIRTY = 3,
  RS_ROW_ITERATOR = 4,
  RS_COLOR_BG = 5,
  RS_COLOR_FG = 6,
  RS_CURSOR_VISUAL_STYLE = 10,
  RS_CURSOR_VISIBLE = 11,
  RS_CURSOR_VIEWPORT_HAS_VALUE = 14,
  RS_CURSOR_VIEWPORT_X = 15,
  RS_CURSOR_VIEWPORT_Y = 16;

const ROW_DIRTY = 1,
  ROW_CELLS = 3;

const CELLS_RAW = 1,
  CELLS_STYLE = 2,
  CELLS_GRAPHEMES_BUF = 4,
  CELLS_BG_COLOR = 5,
  CELLS_FG_COLOR = 6;

const CELL_DATA_WIDE = 3;
const WIDE_WIDE = 1,
  WIDE_SPACER_TAIL = 2,
  WIDE_SPACER_HEAD = 3;

const POINT_VIEWPORT = 1,
  POINT_HISTORY = 3;

const SCROLL_BOTTOM = 1,
  SCROLL_DELTA = 2;

const KEY_ACTION_PRESS = 1;
const MOD_SHIFT = 1 << 0,
  MOD_CTRL = 1 << 1,
  MOD_ALT = 1 << 2,
  MOD_SUPER = 1 << 3;

const MOUSE_ACTION_PRESS = 0,
  MOUSE_ACTION_RELEASE = 1,
  MOUSE_ACTION_MOTION = 2;
const MOUSE_ENCODER_OPT_SIZE = 3,
  MOUSE_ENCODER_OPT_ANY_BUTTON_PRESSED = 4;

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
  ghostty_terminal_scroll_viewport(term: number, behaviorPtr: number): number;
  ghostty_terminal_grid_ref(term: number, pointPtr: number, refPtr: number): number;
  ghostty_grid_ref_cell(refPtr: number, cellPtr: number): number;
  ghostty_grid_ref_graphemes(refPtr: number, bufPtr: number, cap: number, writtenPtr: number): number;
  ghostty_cell_get(cell: bigint, data: number, outPtr: number): number;
  ghostty_render_state_new(alloc: number, slot: number): number;
  ghostty_render_state_free(rs: number): void;
  ghostty_render_state_update(rs: number, term: number): number;
  ghostty_render_state_clean(rs: number): void;
  ghostty_render_state_get(rs: number, data: number, outPtr: number): number;
  ghostty_render_state_row_iterator_new(alloc: number, slot: number): number;
  ghostty_render_state_row_iterator_free(it: number): void;
  ghostty_render_state_row_iterator_next(it: number): number;
  ghostty_render_state_row_get(it: number, data: number, outPtr: number): number;
  ghostty_render_state_row_cells_new(alloc: number, slot: number): number;
  ghostty_render_state_row_cells_free(cells: number): void;
  ghostty_render_state_row_cells_next(cells: number): number;
  ghostty_render_state_row_cells_get(cells: number, data: number, outPtr: number): number;
  ghostty_key_event_new(alloc: number, slot: number): number;
  ghostty_key_event_free(ev: number): void;
  ghostty_key_event_set_action(ev: number, action: number): void;
  ghostty_key_event_set_key(ev: number, key: number): void;
  ghostty_key_event_set_mods(ev: number, mods: number): void;
  ghostty_key_event_set_utf8(ev: number, stringPtr: number): number;
  ghostty_key_event_set_unshifted_codepoint(ev: number, cp: number): void;
  ghostty_key_encoder_new(alloc: number, slot: number): number;
  ghostty_key_encoder_free(enc: number): void;
  ghostty_key_encoder_set_from_terminal(enc: number, term: number): void;
  ghostty_key_encoder_encode(enc: number, ev: number, bufPtr: number, cap: number, writtenPtr: number): number;
  ghostty_mouse_event_new(alloc: number, slot: number): number;
  ghostty_mouse_event_free(ev: number): void;
  ghostty_mouse_event_set_action(ev: number, action: number): void;
  ghostty_mouse_event_set_button(ev: number, btn: number): void;
  ghostty_mouse_event_clear_button(ev: number): void;
  ghostty_mouse_event_set_mods(ev: number, mods: number): void;
  // C aggregate by value is lowered to a wasm32 pointer (two f32s), not two JS numbers.
  ghostty_mouse_event_set_position(ev: number, positionPtr: number): number;
  ghostty_mouse_encoder_new(alloc: number, slot: number): number;
  ghostty_mouse_encoder_free(enc: number): void;
  ghostty_mouse_encoder_set(enc: number, opt: number, valPtr: number): number;
  ghostty_mouse_encoder_set_from_terminal(enc: number, term: number): void;
  ghostty_mouse_encoder_encode(enc: number, ev: number, bufPtr: number, cap: number, writtenPtr: number): number;
  ghostty_paste_encode(
    dataPtr: number,
    dataLen: number,
    bracketed: number,
    outPtr: number,
    outCap: number,
    writtenPtr: number,
  ): number;
  ghostty_formatter_terminal_new(alloc: number, slot: number, term: number): number;
  ghostty_formatter_set(fmt: number, opt: number, valPtr: number): number;
  ghostty_formatter_format_buf(fmt: number, bufPtr: number, cap: number, writtenPtr: number): number;
  ghostty_formatter_free(fmt: number): void;
}

type Wasm = {
  compile(b: Uint8Array): Promise<unknown>;
  instantiate(m: unknown, i: object): Promise<{ exports: unknown }>;
};
const wasm = () => (globalThis as unknown as { WebAssembly: Wasm }).WebAssembly;

function mapMouseButton(button: number): number {
  switch (button) {
    case 0: return 1; // LEFT
    case 1: return 3; // MIDDLE
    case 2: return 2; // RIGHT
    case 3: return 4; // FOUR (wheel up)
    case 4: return 5; // FIVE (wheel down)
    default: return 0; // UNKNOWN
  }
}

export async function createVtRuntime(raw: Uint8Array): Promise<VtRuntime> {
  const [vtMod, trampMod] = await Promise.all([wasm().compile(raw), wasm().compile(WRITE_PTY_TRAMPOLINE)]);
  const replies = new Map<number, string>();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
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
  //   76..111: GhosttyMouseEncoderSize (36B)
  //   112..115: key-event UTF-8 text (up to one Unicode codepoint)
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
  const mem = () => (sync(), cachedView!);
  const bytes = () => (sync(), cachedBytes!);
  const ensureCp = (cap: number) => {
    if (cap > cpCap) {
      e.ghostty_wasm_free(cpBuf, cpCap * 4);
      cpCap = Math.max(cap, cpCap * 2);
      cpBuf = e.ghostty_wasm_alloc(cpCap * 4);
    }
    return cpBuf;
  };
  const ensureWrite = (len: number) => {
    if (len > writeCap) {
      e.ghostty_wasm_free(writeBuf, writeCap);
      writeCap = Math.max(len, writeCap * 2);
      writeBuf = e.ghostty_wasm_alloc(writeCap);
    }
    return writeBuf;
  };
  const readGraphemes = (ptr: number, count: number) => {
    const dv = mem();
    let s = "";
    for (let i = 0; i < count; i++) s += String.fromCodePoint(dv.getUint32(ptr + i * 4, true));
    return s;
  };

  return {
    create(cols: number, rows: number, options?: VtTerminalOptions): VtTerminal {
      if (e.ghostty_terminal_new(0, slot, cols, rows) !== 0) throw new Error("ghostty_terminal_new failed");
      const term = e.ghostty_wasm_take_opaque(slot);

      const allocOpaque = (fn: () => number, name: string, cleanup: () => void): number => {
        if (fn() !== 0) {
          cleanup();
          throw new Error(`${name} failed`);
        }
        return e.ghostty_wasm_take_opaque(slot);
      };

      const rs = allocOpaque(() => e.ghostty_render_state_new(0, slot), "ghostty_render_state_new", () => {
        e.ghostty_terminal_free(term);
      });
      const rowIt = allocOpaque(() => e.ghostty_render_state_row_iterator_new(0, slot), "ghostty_render_state_row_iterator_new", () => {
        e.ghostty_render_state_free(rs);
        e.ghostty_terminal_free(term);
      });
      const rowCells = allocOpaque(() => e.ghostty_render_state_row_cells_new(0, slot), "ghostty_render_state_row_cells_new", () => {
        e.ghostty_render_state_row_iterator_free(rowIt);
        e.ghostty_render_state_free(rs);
        e.ghostty_terminal_free(term);
      });
      const keyEv = allocOpaque(() => e.ghostty_key_event_new(0, slot), "ghostty_key_event_new", () => {
        e.ghostty_render_state_row_cells_free(rowCells);
        e.ghostty_render_state_row_iterator_free(rowIt);
        e.ghostty_render_state_free(rs);
        e.ghostty_terminal_free(term);
      });
      const keyEnc = allocOpaque(() => e.ghostty_key_encoder_new(0, slot), "ghostty_key_encoder_new", () => {
        e.ghostty_key_event_free(keyEv);
        e.ghostty_render_state_row_cells_free(rowCells);
        e.ghostty_render_state_row_iterator_free(rowIt);
        e.ghostty_render_state_free(rs);
        e.ghostty_terminal_free(term);
      });
      const mouseEv = allocOpaque(() => e.ghostty_mouse_event_new(0, slot), "ghostty_mouse_event_new", () => {
        e.ghostty_key_encoder_free(keyEnc);
        e.ghostty_key_event_free(keyEv);
        e.ghostty_render_state_row_cells_free(rowCells);
        e.ghostty_render_state_row_iterator_free(rowIt);
        e.ghostty_render_state_free(rs);
        e.ghostty_terminal_free(term);
      });
      const mouseEnc = allocOpaque(() => e.ghostty_mouse_encoder_new(0, slot), "ghostty_mouse_encoder_new", () => {
        e.ghostty_mouse_event_free(mouseEv);
        e.ghostty_key_encoder_free(keyEnc);
        e.ghostty_key_event_free(keyEv);
        e.ghostty_render_state_row_cells_free(rowCells);
        e.ghostty_render_state_row_iterator_free(rowIt);
        e.ghostty_render_state_free(rs);
        e.ghostty_terminal_free(term);
      });

      const sbBytes = options?.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES;
      const sbLines = options?.scrollbackLines ?? DEFAULT_SCROLLBACK_LINES;
      mem().setUint32(scratch, sbBytes, true);
      e.ghostty_terminal_set(term, OPT_SCROLLBACK_MAX_BYTES, scratch);
      mem().setUint32(scratch, sbLines, true);
      e.ghostty_terminal_set(term, OPT_SCROLLBACK_MAX_LINES, scratch);
      // Enable DEC mode 2027 (grapheme cluster segmentation) by default.
      mem().setUint16(scratch, 2027, true);
      mem().setUint8(scratch + 2, 1);
      e.ghostty_terminal_set(term, OPT_MODE, scratch);
      e.ghostty_terminal_set(term, OPT_WRITE_PTY, writePtyFn);

      let freed = false;
      // Render-state updates consume terminal-global dirty markers. A headless snapshot
      // invalidates the next browser frame. Both readers share the same native cache.
      let snapshotRead = false;

      const modeFn = (m: number): boolean => {
        if (freed) return false;
        mem().setUint16(scratch, m & 0x7fff, true);
        mem().setUint8(scratch + 2, 0);
        return e.ghostty_terminal_get(term, DATA_MODE, scratch) === 0 && mem().getUint8(scratch + 2) !== 0;
      };

      const readCellWide = (cellPtr: number, boxPtr: number): number => {
        mem().setUint8(boxPtr, 0);
        e.ghostty_cell_get(mem().getBigUint64(cellPtr, true), CELL_DATA_WIDE, boxPtr);
        return mem().getUint8(boxPtr);
      };

      const readRowCellsText = (cpBufStruct: number): string => {
        mem().setUint32(cpBufStruct, cpBuf, true);
        mem().setUint32(cpBufStruct + 4, cpCap, true);
        let gr = e.ghostty_render_state_row_cells_get(rowCells, CELLS_GRAPHEMES_BUF, cpBufStruct);
        const len = mem().getUint32(cpBufStruct + 8, true);
        if (gr !== 0 && len > cpCap) {
          const ptr = ensureCp(len);
          mem().setUint32(cpBufStruct, ptr, true);
          mem().setUint32(cpBufStruct + 4, cpCap, true);
          gr = e.ghostty_render_state_row_cells_get(rowCells, CELLS_GRAPHEMES_BUF, cpBufStruct);
        }
        const cp0 = len > 0 ? mem().getUint32(cpBuf, true) : 0;
        return len === 0 || cp0 === 0 ? " " : readGraphemes(cpBuf, len);
      };

      return {
        write: (data: Uint8Array) => {
          if (freed || !data.length) return;
          const ptr = ensureWrite(data.length);
          bytes().set(data, ptr);
          e.ghostty_terminal_vt_write(term, ptr, data.length);
        },
        resize: (c: number, r: number) => {
          if (!freed) e.ghostty_terminal_resize(term, c, r, 0, 0);
        },
        screen: (): VtScreen => {
          if (freed) throw new Error("Terminal is disposed");
          snapshotRead = true;
          const cellPtr = scratch + 32,
            stylePtr = scratch + 40,
            cpBufStruct = scratch + 56,
            boxPtr = scratch + 68,
            rgbPtr = scratch + 72;
          e.ghostty_terminal_get(term, DATA_COLS, boxPtr);
          const curCols = mem().getUint16(boxPtr, true);
          e.ghostty_terminal_get(term, DATA_ROWS, boxPtr);
          const curRows = mem().getUint16(boxPtr, true);
          e.ghostty_terminal_get(term, DATA_CURSOR_X, boxPtr);
          const cx = mem().getUint16(boxPtr, true);
          e.ghostty_terminal_get(term, DATA_CURSOR_Y, boxPtr);
          const cy = mem().getUint16(boxPtr, true);
          e.ghostty_terminal_get(term, DATA_CURSOR_VISIBLE, boxPtr);
          const cvis = mem().getUint8(boxPtr) !== 0;
          e.ghostty_terminal_get(term, DATA_ACTIVE_SCREEN, boxPtr);
          const alternate = mem().getInt32(boxPtr, true) === 1;

          e.ghostty_render_state_update(rs, term);
          const defBg = e.ghostty_render_state_get(rs, RS_COLOR_BG, rgbPtr) === 0
            ? (bytes()[rgbPtr]! << 16) | (bytes()[rgbPtr + 1]! << 8) | bytes()[rgbPtr + 2]!
            : DEFAULT_BG;
          const defFg = e.ghostty_render_state_get(rs, RS_COLOR_FG, rgbPtr) === 0
            ? (bytes()[rgbPtr]! << 16) | (bytes()[rgbPtr + 1]! << 8) | bytes()[rgbPtr + 2]!
            : DEFAULT_FG;

          mem().setUint32(boxPtr, rowIt, true);
          e.ghostty_render_state_get(rs, RS_ROW_ITERATOR, boxPtr);
          const lines: string[] = [];
          const grid: { ch: string[]; bg: number[] }[] = [];
          while (e.ghostty_render_state_row_iterator_next(rowIt)) {
            mem().setUint32(boxPtr, rowCells, true);
            e.ghostty_render_state_row_get(rowIt, ROW_CELLS, boxPtr);
            const ch: string[] = [];
            const bg: number[] = [];
            while (e.ghostty_render_state_row_cells_next(rowCells)) {
              e.ghostty_render_state_row_cells_get(rowCells, CELLS_RAW, cellPtr);
              const wide = readCellWide(cellPtr, boxPtr);
              if (wide === WIDE_SPACER_TAIL) ch.push("");
              else if (wide === WIDE_SPACER_HEAD) ch.push(" ");
              else ch.push(readRowCellsText(cpBufStruct));

              e.ghostty_render_state_row_cells_get(rowCells, CELLS_STYLE, stylePtr);
              const inv = (mem().getUint16(stylePtr + 12, true) & INVERSE) !== 0;
              const cr = e.ghostty_render_state_row_cells_get(rowCells, inv ? CELLS_FG_COLOR : CELLS_BG_COLOR, rgbPtr);
              const b = bytes();
              bg.push(cr === 0 ? (b[rgbPtr]! << 16) | (b[rgbPtr + 1]! << 8) | b[rgbPtr + 2]! : (inv ? defFg : defBg));
            }
            lines.push(ch.join("").trimEnd());
            grid.push({ ch, bg });
          }
          while (lines.length < curRows) {
            lines.push("");
            grid.push({ ch: [], bg: [] });
          }
          return { cols: curCols, rows: curRows, lines, cursor: { row: cy, col: cx, visible: cvis }, alternate, grid };
        },
        frame: (force = false): VtFrame => {
          if (freed) throw new Error("Terminal is disposed");
          force ||= snapshotRead;
          const cellPtr = scratch + 32,
            stylePtr = scratch + 40,
            cpBufStruct = scratch + 56,
            boxPtr = scratch + 68,
            rgbPtr = scratch + 72;

          if (e.ghostty_render_state_update(rs, term) !== 0) {
            throw new Error("ghostty_render_state_update failed");
          }
          // Palette/global changes require repainting all rows even when each row is clean.
          if (e.ghostty_render_state_get(rs, RS_DIRTY, boxPtr) === 0 && mem().getInt32(boxPtr, true) === 2) force = true;

          e.ghostty_terminal_get(term, DATA_COLS, boxPtr);
          const curCols = mem().getUint16(boxPtr, true);
          e.ghostty_terminal_get(term, DATA_ROWS, boxPtr);
          const curRows = mem().getUint16(boxPtr, true);
          e.ghostty_terminal_get(term, DATA_ACTIVE_SCREEN, boxPtr);
          const alternate = mem().getInt32(boxPtr, true) === 1;
          e.ghostty_terminal_get(term, DATA_SCROLLBACK_ROWS, boxPtr);
          const scrollback = mem().getUint32(boxPtr, true);

          // GhosttyTerminalScrollbar is three uint64_t fields even on wasm32.
          let scrollOffset = 0;
          if (e.ghostty_terminal_get(term, DATA_SCROLLBAR, scratch) === 0) {
            const sbTotal = mem().getBigUint64(scratch, true);
            const sbOffset = mem().getBigUint64(scratch + 8, true);
            const sbLen = mem().getBigUint64(scratch + 16, true);
            scrollOffset = Math.max(0, Number(sbTotal - sbOffset - sbLen));
          }

          let cursorVisible = false;
          if (e.ghostty_render_state_get(rs, RS_CURSOR_VISIBLE, boxPtr) === 0) {
            cursorVisible = mem().getUint8(boxPtr) !== 0;
          }
          let cursorStyle = 0;
          if (e.ghostty_render_state_get(rs, RS_CURSOR_VISUAL_STYLE, boxPtr) === 0) {
            cursorStyle = mem().getInt32(boxPtr, true);
          }
          let hasViewportCursor = false;
          if (e.ghostty_render_state_get(rs, RS_CURSOR_VIEWPORT_HAS_VALUE, boxPtr) === 0) {
            hasViewportCursor = mem().getUint8(boxPtr) !== 0;
          }
          let cx = 0, cy = 0;
          if (hasViewportCursor) {
            if (e.ghostty_render_state_get(rs, RS_CURSOR_VIEWPORT_X, boxPtr) === 0) cx = mem().getUint16(boxPtr, true);
            if (e.ghostty_render_state_get(rs, RS_CURSOR_VIEWPORT_Y, boxPtr) === 0) cy = mem().getUint16(boxPtr, true);
          } else {
            cursorVisible = false;
          }

          const defBg = e.ghostty_render_state_get(rs, RS_COLOR_BG, rgbPtr) === 0
            ? (bytes()[rgbPtr]! << 16) | (bytes()[rgbPtr + 1]! << 8) | bytes()[rgbPtr + 2]!
            : DEFAULT_BG;
          const defFg = e.ghostty_render_state_get(rs, RS_COLOR_FG, rgbPtr) === 0
            ? (bytes()[rgbPtr]! << 16) | (bytes()[rgbPtr + 1]! << 8) | bytes()[rgbPtr + 2]!
            : DEFAULT_FG;

          mem().setUint32(boxPtr, rowIt, true);
          e.ghostty_render_state_get(rs, RS_ROW_ITERATOR, boxPtr);
          const lines: VtFrame["lines"] = [];
          let rowIdx = 0;
          while (e.ghostty_render_state_row_iterator_next(rowIt)) {
            let dirty = 1;
            if (!force && e.ghostty_render_state_row_get(rowIt, ROW_DIRTY, boxPtr) === 0) {
              dirty = mem().getUint8(boxPtr);
            }
            if (force || dirty !== 0) {
              mem().setUint32(boxPtr, rowCells, true);
              e.ghostty_render_state_row_get(rowIt, ROW_CELLS, boxPtr);
              const cells: VtCell[] = [];
              while (e.ghostty_render_state_row_cells_next(rowCells)) {
                e.ghostty_render_state_row_cells_get(rowCells, CELLS_RAW, cellPtr);
                const wide = readCellWide(cellPtr, boxPtr);
                let text: string;
                let width: number;
                if (wide === WIDE_SPACER_TAIL) {
                  text = "";
                  width = 0;
                } else if (wide === WIDE_SPACER_HEAD) {
                  text = " ";
                  width = 0;
                } else {
                  text = readRowCellsText(cpBufStruct);
                  width = wide === WIDE_WIDE ? 2 : 1;
                }

                e.ghostty_render_state_row_cells_get(rowCells, CELLS_STYLE, stylePtr);
                const rawFlags = mem().getUint16(stylePtr + 12, true);
                const flags = rawFlags & 0xff;
                const underline = (rawFlags >> 8) & 0x7;
                const inv = (rawFlags & INVERSE) !== 0;

                const fgRes = e.ghostty_render_state_row_cells_get(rowCells, inv ? CELLS_BG_COLOR : CELLS_FG_COLOR, rgbPtr);
                const fg = fgRes === 0
                  ? (bytes()[rgbPtr]! << 16) | (bytes()[rgbPtr + 1]! << 8) | bytes()[rgbPtr + 2]!
                  : (inv ? defBg : defFg);
                const bgRes = e.ghostty_render_state_row_cells_get(rowCells, inv ? CELLS_FG_COLOR : CELLS_BG_COLOR, rgbPtr);
                const bg = bgRes === 0
                  ? (bytes()[rgbPtr]! << 16) | (bytes()[rgbPtr + 1]! << 8) | bytes()[rgbPtr + 2]!
                  : (inv ? defFg : defBg);

                cells.push({ text, width, fg, bg, flags, underline });
              }
              // Native row-local ranges follow wide cells, wraps and tracked output scrolling.
              mem().setUint32(scratch, 8, true); // GhosttyRenderStateRowSelection (wasm32).
              const selection = e.ghostty_render_state_row_get(rowIt, 4 /* SELECTION */, scratch) === 0
                ? { start: mem().getUint16(scratch + 4, true), end: mem().getUint16(scratch + 6, true) }
                : undefined;
              lines.push({ row: rowIdx, cells, selection });
            }
            rowIdx++;
          }

          e.ghostty_render_state_clean(rs);
          snapshotRead = false;
          return {
            cols: curCols,
            rows: curRows,
            cursor: { row: cy, col: cx, visible: cursorVisible, style: cursorStyle },
            lines,
            alternate,
            scrollback,
            scrollOffset,
          };
        },
        setTheme: (fg: number, bg: number, cursor: number) => {
          if (freed) return;
          const setRgb = (opt: number, c: number) => {
            bytes()[scratch] = (c >> 16) & 0xff;
            bytes()[scratch + 1] = (c >> 8) & 0xff;
            bytes()[scratch + 2] = c & 0xff;
            e.ghostty_terminal_set(term, opt, scratch);
          };
          setRgb(OPT_COLOR_FOREGROUND, fg);
          setRgb(OPT_COLOR_BACKGROUND, bg);
          setRgb(OPT_COLOR_CURSOR, cursor);
        },
        scroll: (delta: number) => {
          if (freed || delta === 0) return;
          mem().setInt32(scratch, SCROLL_DELTA, true);
          // The padded union has uint64 alignment, so its intptr_t delta starts at +8.
          mem().setInt32(scratch + 8, Math.trunc(delta), true);
          e.ghostty_terminal_scroll_viewport(term, scratch);
        },
        scrollToBottom: () => {
          if (freed) return;
          mem().setInt32(scratch, SCROLL_BOTTOM, true);
          mem().setInt32(scratch + 8, 0, true);
          e.ghostty_terminal_scroll_viewport(term, scratch);
        },
        select: (start: { col: number; row: number }, end: { col: number; row: number }) => {
          if (freed) return;
          const ptPtr = scratch;
          const selPtr = scratch + 76; // Frozen 20B GhosttySelection: start(8), end(8), rectangle(1+3).
          bytes().fill(0, selPtr, selPtr + 20);

          mem().setInt32(ptPtr, POINT_VIEWPORT, true);
          mem().setUint16(ptPtr + 8, Math.max(0, start.col), true);
          mem().setUint32(ptPtr + 12, Math.max(0, start.row), true);
          if (e.ghostty_terminal_grid_ref(term, ptPtr, selPtr) !== 0) return;

          mem().setInt32(ptPtr, POINT_VIEWPORT, true);
          mem().setUint16(ptPtr + 8, Math.max(0, end.col), true);
          mem().setUint32(ptPtr + 12, Math.max(0, end.row), true);
          if (e.ghostty_terminal_grid_ref(term, ptPtr, selPtr + 8) !== 0) return;
          e.ghostty_terminal_set(term, OPT_SELECTION, selPtr);
        },
        clearSelection: () => {
          if (freed) return;
          e.ghostty_terminal_set(term, OPT_SELECTION, 0);
        },
        selectionText: (): string => {
          if (freed) return "";
          const selPtr = scratch + 76;
          if (e.ghostty_terminal_get(term, DATA_SELECTION, selPtr) !== 0) return "";
          if (e.ghostty_formatter_terminal_new(0, slot, term) !== 0) return "";
          const fmt = e.ghostty_wasm_take_opaque(slot);
          try {
            if (e.ghostty_formatter_set(fmt, FORMATTER_OPT_SELECTION, selPtr) !== 0) return "";
            mem().setUint8(scratch, 1);
            if (e.ghostty_formatter_set(fmt, 2 /* UNWRAP */, scratch) !== 0) return "";
            const writtenPtr = scratch + 72;
            let rc = e.ghostty_formatter_format_buf(fmt, writeBuf, writeCap, writtenPtr);
            const needed = mem().getUint32(writtenPtr, true);
            if (rc !== 0 && needed > writeCap) {
              ensureWrite(needed);
              rc = e.ghostty_formatter_format_buf(fmt, writeBuf, writeCap, writtenPtr);
            }
            if (rc !== 0) return "";
            const written = mem().getUint32(writtenPtr, true);
            return written > 0 ? decoder.decode(new Uint8Array(e.memory.buffer, writeBuf, written)) : "";
          } finally {
            e.ghostty_formatter_free(fmt);
          }
        },
        key: (event: VtKeyEvent): string => {
          if (freed) return "";
          const gKey = domKeyToGhosttyKey(event.code, event.key);
          const mods =
            (event.shift ? MOD_SHIFT : 0) |
            (event.ctrl ? MOD_CTRL : 0) |
            (event.alt ? MOD_ALT : 0) |
            (event.meta ? MOD_SUPER : 0);

          e.ghostty_key_event_set_action(keyEv, KEY_ACTION_PRESS);
          e.ghostty_key_event_set_key(keyEv, gKey);
          e.ghostty_key_event_set_mods(keyEv, mods);

          const cp = event.key.codePointAt(0);
          const printable = cp !== undefined && cp >= 0x20 && cp !== 0x7f && event.key === String.fromCodePoint(cp);
          const utf8 = printable ? encoder.encode(event.key) : new Uint8Array(0);
          // GhosttyString is a by-value C aggregate, lowered to a pointer to {ptr, len}.
          // Keep its text separate from the encoder output so prefixes cannot overwrite it.
          const stringPtr = scratch + 56, textPtr = scratch + 112;
          bytes().set(utf8, textPtr);
          mem().setUint32(stringPtr, utf8.length ? textPtr : 0, true);
          mem().setUint32(stringPtr + 4, utf8.length, true);
          e.ghostty_key_event_set_utf8(keyEv, stringPtr);
          e.ghostty_key_event_set_unshifted_codepoint(keyEv, printable ? cp : 0);

          e.ghostty_key_encoder_set_from_terminal(keyEnc, term);
          const writtenPtr = scratch + 72;
          const rc = e.ghostty_key_encoder_encode(keyEnc, keyEv, writeBuf, writeCap, writtenPtr);
          if (rc !== 0) return "";
          const written = mem().getUint32(writtenPtr, true);
          return written > 0 ? decoder.decode(new Uint8Array(e.memory.buffer, writeBuf, written)) : "";
        },
        mouse: (event: VtMouseEvent): string => {
          if (freed) return "";
          const action =
            event.action === "press"
              ? MOUSE_ACTION_PRESS
              : event.action === "release"
                ? MOUSE_ACTION_RELEASE
                : MOUSE_ACTION_MOTION;
          e.ghostty_mouse_event_set_action(mouseEv, action);

          if (event.action === "motion" && event.buttons === 0) {
            e.ghostty_mouse_event_clear_button(mouseEv);
          } else {
            const button = event.action === "motion" ? (event.buttons & 1 ? 0 : event.buttons & 4 ? 1 : 2) : event.button;
            e.ghostty_mouse_event_set_button(mouseEv, mapMouseButton(button));
          }

          e.ghostty_mouse_event_set_mods(mouseEv, event.mods);
          mem().setFloat32(scratch, event.x, true);
          mem().setFloat32(scratch + 4, event.y, true);
          e.ghostty_mouse_event_set_position(mouseEv, scratch);

          const boxPtr = scratch + 68;
          e.ghostty_terminal_get(term, DATA_COLS, boxPtr);
          const curCols = mem().getUint16(boxPtr, true);
          e.ghostty_terminal_get(term, DATA_ROWS, boxPtr);
          const curRows = mem().getUint16(boxPtr, true);

          const sizePtr = scratch + 76;
          mem().setUint32(sizePtr, 36, true);
          mem().setUint32(sizePtr + 4, Math.max(1, Math.round(curCols * event.cellWidth)), true);
          mem().setUint32(sizePtr + 8, Math.max(1, Math.round(curRows * event.cellHeight)), true);
          mem().setUint32(sizePtr + 12, Math.max(1, Math.round(event.cellWidth)), true);
          mem().setUint32(sizePtr + 16, Math.max(1, Math.round(event.cellHeight)), true);
          mem().setUint32(sizePtr + 20, 0, true);
          mem().setUint32(sizePtr + 24, 0, true);
          mem().setUint32(sizePtr + 28, 0, true);
          mem().setUint32(sizePtr + 32, 0, true);
          e.ghostty_mouse_encoder_set(mouseEnc, MOUSE_ENCODER_OPT_SIZE, sizePtr);

          mem().setUint8(boxPtr, event.buttons !== 0 ? 1 : 0);
          e.ghostty_mouse_encoder_set(mouseEnc, MOUSE_ENCODER_OPT_ANY_BUTTON_PRESSED, boxPtr);
          e.ghostty_mouse_encoder_set_from_terminal(mouseEnc, term);

          const writtenPtr = scratch + 72;
          const rc = e.ghostty_mouse_encoder_encode(mouseEnc, mouseEv, writeBuf, writeCap, writtenPtr);
          if (rc !== 0) return "";
          const written = mem().getUint32(writtenPtr, true);
          return written > 0 ? decoder.decode(new Uint8Array(e.memory.buffer, writeBuf, written)) : "";
        },
        paste: (text: string): string => {
          if (freed || !text) return "";
          const bracketed = modeFn(2004) ? 1 : 0;
          const utf8 = encoder.encode(text);
          const totalNeeded = utf8.length + (utf8.length + 16);
          const basePtr = ensureWrite(totalNeeded);
          bytes().set(utf8, basePtr);
          const outPtr = basePtr + utf8.length;
          const outCap = writeCap - utf8.length;
          const writtenPtr = scratch + 72;
          const rc = e.ghostty_paste_encode(basePtr, utf8.length, bracketed, outPtr, outCap, writtenPtr);
          if (rc !== 0) {
            const sanitized = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
            return bracketed ? `\x1b[200~${sanitized}\x1b[201~` : sanitized;
          }
          const written = mem().getUint32(writtenPtr, true);
          return written > 0 ? decoder.decode(new Uint8Array(e.memory.buffer, outPtr, written)) : "";
        },
        scrollback: (count: number): string[] => {
          if (freed || count <= 0) return [];
          const ptPtr = scratch,
            refPtr = scratch + 24,
            cellPtr = scratch + 32,
            boxPtr = scratch + 68,
            writtenPtr = scratch + 72;
          e.ghostty_terminal_get(term, DATA_SCROLLBACK_ROWS, boxPtr);
          const total = mem().getUint32(boxPtr, true);
          e.ghostty_terminal_get(term, DATA_COLS, boxPtr);
          const curCols = mem().getUint16(boxPtr, true);
          const out: string[] = [];
          for (let y = Math.max(0, total - count); y < total; y++) {
            let s = "";
            for (let x = 0; x < curCols; x++) {
              mem().setInt32(ptPtr, POINT_HISTORY, true);
              mem().setUint16(ptPtr + 8, x, true);
              mem().setUint32(ptPtr + 12, y, true);
              if (e.ghostty_terminal_grid_ref(term, ptPtr, refPtr) !== 0) {
                s += " ";
                continue;
              }
              e.ghostty_grid_ref_cell(refPtr, cellPtr);
              const wide = readCellWide(cellPtr, boxPtr);
              if (wide === WIDE_SPACER_TAIL) continue;
              if (wide === WIDE_SPACER_HEAD) {
                s += " ";
                continue;
              }
              let gr = e.ghostty_grid_ref_graphemes(refPtr, cpBuf, cpCap, writtenPtr);
              const len = mem().getUint32(writtenPtr, true);
              if (gr !== 0 && len > cpCap) {
                gr = e.ghostty_grid_ref_graphemes(refPtr, ensureCp(len), cpCap, writtenPtr);
              }
              const cp0 = len > 0 ? mem().getUint32(cpBuf, true) : 0;
              s += len === 0 || cp0 === 0 ? " " : readGraphemes(cpBuf, len);
            }
            out.push(s.trimEnd());
          }
          return out;
        },
        mode: modeFn,
        responses: () => {
          if (freed) return "";
          const out = replies.get(term) ?? "";
          replies.delete(term);
          return out;
        },
        dispose: () => {
          if (freed) return;
          freed = true;
          replies.delete(term);
          e.ghostty_mouse_encoder_free(mouseEnc);
          e.ghostty_mouse_event_free(mouseEv);
          e.ghostty_key_encoder_free(keyEnc);
          e.ghostty_key_event_free(keyEv);
          e.ghostty_render_state_row_cells_free(rowCells);
          e.ghostty_render_state_row_iterator_free(rowIt);
          e.ghostty_render_state_free(rs);
          e.ghostty_terminal_free(term);
        },
      };
    },
  };
}
