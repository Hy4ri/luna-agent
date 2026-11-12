import type { VtTerminal } from "../../../src/terminal/vt-core";
import { TermCanvas, type CellPoint } from "./term-canvas";

/** Native text/IME input plus mode-aware special keys; no browser events enter the WASM core. */
export class TermInput {
  readonly textarea = document.createElement("textarea");
  private readonly events = new AbortController();
  private composing = false;
  private compositionFinal: string | undefined;
  private compositionTimer?: ReturnType<typeof setTimeout>;
  private holdTimer?: ReturnType<typeof setTimeout>;
  private pointer?: { id: number; start: CellPoint; x: number; y: number; touch: boolean; moved: boolean; selecting: boolean };
  private selected = false;
  private wheelRemainder = 0;

  constructor(private canvas: TermCanvas, private terminal: () => VtTerminal, private send: (data: string) => void, private redraw: () => void) {
    const input = this.textarea;
    input.setAttribute("aria-label", "Terminal input");
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("autocomplete", "off");
    input.spellcheck = false;
    input.wrap = "off";
    input.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px;padding:0;border:0;opacity:.01;font-size:16px;resize:none;overflow:hidden;z-index:1";
    canvas.element.append(input);
    const opts = { signal: this.events.signal };
    input.addEventListener("focus", () => canvas.setFocus(true), opts);
    input.addEventListener("blur", () => canvas.setFocus(false), opts);
    input.addEventListener("keydown", e => this.keydown(e), opts);
    input.addEventListener("compositionstart", () => { this.composing = true; }, opts);
    input.addEventListener("compositionend", e => {
      this.composing = false;
      this.compositionFinal = e.data;
      this.emitText(e.data);
      input.value = "";
      clearTimeout(this.compositionTimer);
      this.compositionTimer = setTimeout(() => { this.compositionFinal = undefined; }, 0);
    }, opts);
    input.addEventListener("beforeinput", e => {
      if (this.composing || e.isComposing) return;
      const key = e.inputType === "deleteContentBackward" ? "Backspace" : e.inputType === "deleteContentForward" ? "Delete" : e.inputType === "insertLineBreak" || e.inputType === "insertParagraph" ? "Enter" : undefined;
      if (key) { e.preventDefault(); this.emitKey(key); input.value = ""; }
    }, opts);
    input.addEventListener("input", event => {
      const e = event as InputEvent;
      if (this.composing || e.isComposing) return;
      const data = e.data ?? input.value;
      if (this.compositionFinal === undefined || data !== this.compositionFinal) this.emitText(data);
      this.compositionFinal = undefined;
      input.value = "";
    }, opts);
    input.addEventListener("paste", e => {
      const text = e.clipboardData?.getData("text/plain");
      if (text === undefined) return;
      e.preventDefault();
      this.clearSelection();
      this.terminal().scrollToBottom();
      this.send(this.terminal().paste(text));
      this.redraw();
    }, opts);
    input.addEventListener("copy", e => {
      if (!this.selected) return;
      e.clipboardData?.setData("text/plain", this.terminal().selectionText());
      e.preventDefault();
    }, opts);
    canvas.element.addEventListener("pointerdown", e => this.pointerdown(e), opts);
    canvas.element.addEventListener("pointermove", e => this.pointermove(e), opts);
    canvas.element.addEventListener("pointerup", e => this.pointerup(e), opts);
    canvas.element.addEventListener("pointercancel", () => this.cancelPointer(), opts);
    canvas.element.addEventListener("wheel", e => this.wheel(e), { ...opts, passive: false });
    canvas.element.addEventListener("contextmenu", () => {
      if (this.selected) { input.value = this.terminal().selectionText(); input.select(); }
    }, opts);
  }

  focus() { this.textarea.focus({ preventScroll: true }); }
  private tracking() { const t = this.terminal(); return t.mode(1000) || t.mode(1002) || t.mode(1003); }
  private mods(e: MouseEvent) { return (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0); }
  private mouse(e: MouseEvent, action: "press" | "release" | "motion", button = e.button) {
    const rect = this.canvas.canvas.getBoundingClientRect();
    this.send(this.terminal().mouse({ action, button, x: e.clientX - rect.left, y: e.clientY - rect.top, mods: this.mods(e), cellWidth: this.canvas.width, cellHeight: this.canvas.height, buttons: e.buttons }));
  }
  private emitKey(key: string) {
    this.clearSelection();
    this.terminal().scrollToBottom();
    this.send(this.terminal().key({ key, code: key, shift: false, alt: false, ctrl: false, meta: false }));
    this.redraw();
  }
  private emitText(text: string) {
    if (!text) return;
    this.clearSelection();
    this.terminal().scrollToBottom();
    this.send(text);
    this.redraw();
  }

  private keydown(e: KeyboardEvent) {
    if (e.isComposing || this.composing || e.keyCode === 229) return;
    const shortcut = e.ctrlKey || e.metaKey;
    if (shortcut && e.key.toLowerCase() === "v") return; // Browser paste event owns clipboard access.
    if (shortcut && e.key.toLowerCase() === "c" && this.selected) {
      e.preventDefault(); this.copy(); return;
    }
    if (shortcut && e.shiftKey && e.key.toLowerCase() === "c") { e.preventDefault(); this.copy(); return; }
    if (e.metaKey && !e.altKey) return; // Keep browser/OS shortcuts; do not turn Cmd-L into shell input.
    if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Unidentified", "Dead"].includes(e.key)) return;
    if (!e.ctrlKey && !e.altKey && e.key.length === 1) return; // Native input handles printable text and mobile keyboards.
    const bytes = this.terminal().key({ key: e.key, code: e.code, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey });
    if (!bytes) return;
    e.preventDefault();
    this.clearSelection();
    this.terminal().scrollToBottom();
    this.send(bytes);
    this.redraw();
  }

  private copy() {
    if (!this.selected) return;
    const text = this.terminal().selectionText();
    if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).catch(() => this.copyFallback(text));
    else this.copyFallback(text);
  }
  private copyFallback(text: string) {
    this.textarea.value = text;
    this.textarea.select();
    document.execCommand("copy");
    this.textarea.value = "";
  }
  clearSelection() {
    this.selected = false;
    this.terminal().clearSelection();
    this.redraw();
  }
  private select(start: CellPoint, end: CellPoint) {
    this.selected = true;
    this.terminal().select(start, end);
    this.redraw();
  }

  private pointerdown(e: PointerEvent) {
    if (e.target === this.textarea) return;
    if (e.button !== 0 && e.button !== 1 && !this.tracking()) return;
    const touch = e.pointerType === "touch";
    if (!touch) { e.preventDefault(); this.focus(); }
    this.canvas.element.setPointerCapture(e.pointerId);
    const start = this.canvas.point(e.clientX, e.clientY);
    this.pointer = { id: e.pointerId, start, x: e.clientX, y: e.clientY, touch, moved: false, selecting: !touch };
    if (this.tracking() && !e.shiftKey) { this.mouse(e, "press"); return; }
    this.clearSelection();
    if (touch) {
      this.holdTimer = setTimeout(() => {
        if (!this.pointer || this.pointer.moved) return;
        this.pointer.selecting = true;
        const word = this.canvas.word(start);
        this.pointer.start = word.start;
        this.select(word.start, word.end);
      }, 450);
    } else if (e.detail >= 2) {
      const word = this.canvas.word(start);
      this.pointer.start = word.start;
      this.select(word.start, word.end);
    }
  }

  private pointermove(e: PointerEvent) {
    const p = this.pointer;
    if (!p || p.id !== e.pointerId) {
      if (this.tracking() && this.terminal().mode(1003) && !e.shiftKey) this.mouse(e, "motion");
      return;
    }
    if (this.tracking() && !e.shiftKey) { this.mouse(e, "motion"); return; }
    if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) > 5) { p.moved = true; clearTimeout(this.holdTimer); }
    if (p.touch && !p.selecting) {
      const rows = Math.trunc((p.y - e.clientY) / this.canvas.height);
      if (rows) { this.terminal().scroll(rows); p.y -= rows * this.canvas.height; this.clearSelection(); this.redraw(); }
    } else if (p.moved || p.selecting && this.selected) this.select(p.start, this.canvas.point(e.clientX, e.clientY));
  }

  private pointerup(e: PointerEvent) {
    const p = this.pointer;
    if (!p || p.id !== e.pointerId) return;
    if (this.tracking() && !e.shiftKey) this.mouse(e, "release");
    if (p.touch && !p.moved && !p.selecting) this.focus();
    this.cancelPointer();
  }
  private cancelPointer() {
    clearTimeout(this.holdTimer);
    if (this.pointer && this.canvas.element.hasPointerCapture(this.pointer.id)) this.canvas.element.releasePointerCapture(this.pointer.id);
    this.pointer = undefined;
  }
  private wheel(e: WheelEvent) {
    if (e.ctrlKey) return; // Browser zoom gesture.
    e.preventDefault();
    if (this.tracking() && !e.shiftKey) {
      const ticks = Math.min(10, Math.max(1, Math.ceil(Math.abs(e.deltaY) / this.canvas.height)));
      for (let i = 0; i < ticks; i++) this.mouse(e, "press", e.deltaY < 0 ? 3 : 4);
    } else {
      const dy = e.deltaY * (e.deltaMode === 1 ? this.canvas.height : e.deltaMode === 2 ? this.canvas.element.clientHeight : 1);
      this.wheelRemainder += dy / this.canvas.height;
      const rows = Math.trunc(this.wheelRemainder);
      if (rows) { this.wheelRemainder -= rows; this.terminal().scroll(rows); this.clearSelection(); this.redraw(); }
    }
  }

  dispose() {
    this.events.abort();
    clearTimeout(this.compositionTimer);
    this.cancelPointer();
    this.textarea.remove();
  }
}
