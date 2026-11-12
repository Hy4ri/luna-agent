import type { VtFrame, VtCell } from "../../../src/terminal/vt-core";

export interface CellPoint { col: number; row: number }
export interface CanvasTheme { fg: number; bg: number; cursor: number; selection: string }
const rgb = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

/** Canvas owns pixels only. Terminal state, viewport, and selection text belong to libghostty. */
export class TermCanvas {
  readonly element = document.createElement("div");
  readonly canvas = document.createElement("canvas");
  private readonly overlay = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly top: CanvasRenderingContext2D;
  private cells: VtCell[][] = [];
  private last?: VtFrame;
  private selections = new Map<number, { start: number; end: number }>();
  private blink = true;
  private focused = false;
  private dpr = 0;
  width = 8;
  height = 17;
  private baseline = 13;
  private font = "monospace";
  private fontSize = 13;
  theme: CanvasTheme = { fg: 0xececec, bg: 0x121212, cursor: 0xe86060, selection: "rgba(128,128,128,.4)" };

  constructor() {
    this.element.style.cssText = "position:relative;overflow:hidden;touch-action:none;isolation:isolate";
    this.canvas.style.cssText = "display:block;position:absolute;inset:0";
    this.overlay.style.cssText = "position:absolute;inset:0;pointer-events:none";
    this.canvas.setAttribute("aria-hidden", "true");
    this.overlay.setAttribute("aria-hidden", "true");
    const ctx = this.canvas.getContext("2d", { alpha: false });
    const top = this.overlay.getContext("2d");
    if (!ctx || !top) throw new Error("Canvas2D is unavailable.");
    this.ctx = ctx;
    this.top = top;
    this.element.append(this.canvas, this.overlay);
  }

  configure(font: string, fontSize: number, theme: CanvasTheme) {
    this.font = font;
    this.fontSize = fontSize;
    this.theme = theme;
    this.ctx.font = `${fontSize}px ${font}`;
    const metrics = this.ctx.measureText("MMMMMMMMMM");
    this.width = Math.max(1, metrics.width / 10);
    this.height = Math.ceil(fontSize * 1.35);
    this.baseline = Math.round((this.height - fontSize) / 2 + (metrics.actualBoundingBoxAscent || fontSize * .8));
    this.element.style.background = rgb(theme.bg);
  }

  resize(width: number, height: number): boolean {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
    this.element.style.width = `${width}px`;
    this.element.style.height = `${height}px`;
    if (this.canvas.width === w && this.canvas.height === h && this.dpr === dpr) return false;
    this.dpr = dpr;
    for (const canvas of [this.canvas, this.overlay]) {
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.top.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.fillStyle = rgb(this.theme.bg);
    this.ctx.fillRect(0, 0, width, height);
    this.cells = [];
    this.selections.clear();
    return true;
  }

  draw(frame: VtFrame) {
    this.last = frame;
    this.cells.length = frame.rows;
    for (const line of frame.lines) {
      this.cells[line.row] = line.cells;
      if (line.selection) this.selections.set(line.row, line.selection);
      else this.selections.delete(line.row);
      this.drawRow(line.row, line.cells, frame.cols);
    }
    this.drawOverlay();
  }

  private drawRow(row: number, cells: VtCell[], cols: number) {
    const { ctx, width: w, height: h } = this;
    const y = row * h;
    ctx.fillStyle = rgb(this.theme.bg);
    ctx.fillRect(0, y, cols * w, h);
    for (let x = 0; x < cells.length; x++) {
      const cell = cells[x]!;
      ctx.fillStyle = rgb(cell.bg);
      ctx.fillRect(x * w, y, Math.max(1, cell.width) * w, h);
    }
    for (let x = 0; x < cells.length; x++) {
      const cell = cells[x]!;
      if (!cell.width || cell.flags & 32) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x * w, y, cell.width * w, h);
      ctx.clip();
      ctx.font = `${cell.flags & 2 ? "italic " : ""}${cell.flags & 1 ? "bold " : ""}${this.fontSize}px ${this.font}`;
      ctx.fillStyle = rgb(cell.fg);
      ctx.globalAlpha = cell.flags & 4 ? .55 : 1;
      ctx.fillText(cell.text, x * w, y + this.baseline);
      ctx.strokeStyle = rgb(cell.fg);
      ctx.lineWidth = Math.max(1, this.fontSize / 14);
      const line = (ly: number) => { ctx.beginPath(); ctx.moveTo(x * w, ly); ctx.lineTo((x + cell.width) * w, ly); ctx.stroke(); };
      if (cell.underline) {
        const uy = Math.min(y + h - 2, y + this.baseline + 2);
        if (cell.underline === 3) {
          ctx.beginPath(); ctx.moveTo(x * w, uy);
          for (let dx = 1; dx <= cell.width * w; dx++) ctx.lineTo(x * w + dx, uy + Math.sin(dx * Math.PI / 3));
          ctx.stroke();
        } else {
          if (cell.underline === 4) ctx.setLineDash([1, 2]);
          if (cell.underline === 5) ctx.setLineDash([3, 2]);
          line(uy);
          if (cell.underline === 2) line(uy - 2);
        }
      }
      if (cell.flags & 64) line(y + this.baseline - this.fontSize * .3);
      if (cell.flags & 128) line(y + 1);
      ctx.restore();
    }
  }

  setFocus(focused: boolean) { this.focused = focused; this.blink = true; this.drawOverlay(); }
  tick() { this.blink = !this.blink; this.drawOverlay(); }

  private drawOverlay() {
    const { top, width: w, height: h, last } = this;
    top.clearRect(0, 0, this.overlay.width / (this.dpr || 1), this.overlay.height / (this.dpr || 1));
    if (!last) return;
    top.fillStyle = this.theme.selection;
    for (const [row, range] of this.selections) {
      if (row < last.rows) top.fillRect(range.start * w, row * h, (range.end - range.start + 1) * w, h);
    }
    if (!last.cursor.visible || last.scrollOffset !== 0 || (this.focused && !this.blink)) return;
    const x = last.cursor.col * w, y = last.cursor.row * h;
    top.strokeStyle = rgb(this.theme.cursor);
    top.fillStyle = rgb(this.theme.cursor);
    if (!this.focused || last.cursor.style === 3) { top.lineWidth = 1; top.strokeRect(x + .5, y + .5, w - 1, h - 1); }
    else if (last.cursor.style === 2) top.fillRect(x, y + h - 2, w, 2);
    else if (last.cursor.style === 0) top.fillRect(x, y, 2, h);
    else {
      top.globalAlpha = .65; top.fillRect(x, y, w, h); top.globalAlpha = 1;
    }
  }

  point(clientX: number, clientY: number): CellPoint {
    const rect = this.canvas.getBoundingClientRect();
    return { col: Math.max(0, Math.min((this.last?.cols ?? 1) - 1, Math.floor((clientX - rect.left) / this.width))), row: Math.max(0, Math.min((this.last?.rows ?? 1) - 1, Math.floor((clientY - rect.top) / this.height))) };
  }

  word(point: CellPoint): { start: CellPoint; end: CellPoint } {
    const cells = this.cells[point.row] ?? [];
    const word = (index: number) => /[\p{L}\p{N}_./~:-]/u.test(cells[index]?.text ?? "");
    let a = point.col, b = point.col;
    if (word(a)) { while (a > 0 && word(a - 1)) a--; while (b + 1 < cells.length && word(b + 1)) b++; }
    return { start: { row: point.row, col: a }, end: { row: point.row, col: b } };
  }
}
