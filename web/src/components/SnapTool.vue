<script setup lang="ts">
// Snap tool (#437): select a region of the UI, then start a new session with a screenshot and the DOM of that region.
import { ref, computed, nextTick, onUnmounted } from "vue";
import { Crop, X, Send, Loader2 } from "@lucide/vue";
import { domToCanvas } from "modern-screenshot";
import { chat, newSession, addErr } from "@/stores/chat";
import { composer, addAttachment, send } from "@/stores/composer";

type Rect = { x: number; y: number; w: number; h: number };
const MAX_DOM = 200_000;
const mode = ref<"idle" | "select" | "review">("idle");
const rect = ref<Rect | null>(null);
const start = ref<{ x: number; y: number } | null>(null);
const busy = ref(false);
const note = ref("");
const preview = ref("");
let shot: { png: Blob; html: string; rect: Rect; target: string } | null = null;

const box = computed(() => rect.value && ({ left: rect.value.x + "px", top: rect.value.y + "px", width: rect.value.w + "px", height: rect.value.h + "px" }));
const inUi = (el: Element | null) => !!el?.closest("[data-snap-ui]");

function begin() { mode.value = "select"; rect.value = null; start.value = null; shot = null; note.value = ""; preview.value = ""; }
function cancel() { mode.value = "idle"; rect.value = null; start.value = null; shot = null; busy.value = false; }
function down(e: PointerEvent) {
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  start.value = { x: e.clientX, y: e.clientY }; rect.value = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
}
function move(e: PointerEvent) {
  const s = start.value; if (!s) return;
  rect.value = { x: Math.min(s.x, e.clientX), y: Math.min(s.y, e.clientY), w: Math.abs(e.clientX - s.x), h: Math.abs(e.clientY - s.y) };
}
async function up() {
  const r = rect.value; start.value = null;
  if (!r || r.w < 12 || r.h < 12) { rect.value = null; return; }
  busy.value = true;
  try { await capture(r); mode.value = "review"; await nextTick(); }
  catch (e) { addErr("Snap failed: " + (e as Error).message); cancel(); }
  finally { busy.value = false; }
}

function selector(el: Element): string {
  const parts: string[] = [];
  for (let n: Element | null = el; n && n !== document.body && parts.length < 5; n = n.parentElement) {
    const cls = [...n.classList].slice(0, 2).map(c => "." + CSS.escape(c)).join("");
    parts.unshift(n.tagName.toLowerCase() + (n.id ? "#" + CSS.escape(n.id) : "") + cls);
    if (n.id) break;
  }
  return parts.join(" > ");
}

/** Smallest element that contains the whole selection. */
function commonAncestor(r: Rect): Element {
  const pts = [[r.x + 1, r.y + 1], [r.x + r.w - 1, r.y + 1], [r.x + 1, r.y + r.h - 1], [r.x + r.w - 1, r.y + r.h - 1], [r.x + r.w / 2, r.y + r.h / 2]];
  const els = pts.map(([x, y]) => document.elementsFromPoint(x, y).find(el => !inUi(el)) || document.body);
  let a: Element | null = els[0];
  while (a && !els.every(el => a!.contains(el))) a = a.parentElement;
  return a || document.body;
}

/** Serialize only elements that intersect the selection. Drops scripts, SVG paths, and inline data URLs. */
function domOf(root: Element, r: Rect): string {
  let size = 0;
  const hit = (el: Element) => { const b = el.getBoundingClientRect(); return b.right > r.x && b.left < r.x + r.w && b.bottom > r.y && b.top < r.y + r.h; };
  const walk = (el: Element, depth: number): string => {
    if (inUi(el) || /^(SCRIPT|STYLE|NOSCRIPT|LINK|META)$/.test(el.tagName)) return "";
    const tag = el.tagName.toLowerCase();
    if (el instanceof SVGElement && tag !== "svg") return "";
    const attrs = [...el.attributes].filter(a => !/^(on|data-v-)/.test(a.name)).map(a => {
      const v = a.value.length > 160 ? a.value.slice(0, 160) + "…" : a.value;
      return ` ${a.name}="${v.replace(/"/g, "&quot;")}"`;
    }).join("");
    const pad = "  ".repeat(depth);
    const kids = [...el.children].filter(hit);
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent!.trim()).filter(Boolean).join(" ").slice(0, 300);
    if (tag === "svg") return `${pad}<svg${attrs}/>\n`;
    if (size > MAX_DOM) return `${pad}<!-- truncated -->\n`;
    let out = `${pad}<${tag}${attrs}>${own}`;
    if (kids.length) { out += "\n" + kids.map(k => walk(k, depth + 1)).join("") + pad; }
    out += `</${tag}>\n`;
    size += out.length;
    return out;
  };
  return walk(root, 0);
}

async function capture(r: Rect) {
  const root = commonAncestor(r);
  const b = root.getBoundingClientRect();
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const canvas = await domToCanvas(root as HTMLElement, {
    scale, filter: n => !(n instanceof Element && inUi(n)),
    backgroundColor: getComputedStyle(document.body).backgroundColor,
  });
  const crop = document.createElement("canvas");
  crop.width = Math.round(r.w * scale); crop.height = Math.round(r.h * scale);
  crop.getContext("2d")!.drawImage(canvas, Math.round((r.x - b.left) * scale), Math.round((r.y - b.top) * scale), crop.width, crop.height, 0, 0, crop.width, crop.height);
  const png = await new Promise<Blob>((res, rej) => crop.toBlob(x => x ? res(x) : rej(new Error("empty image")), "image/png"));
  shot = { png, html: domOf(root, r), rect: r, target: selector(root) };
  preview.value = URL.createObjectURL(png);
}

async function submit() {
  if (!shot || busy.value) return;
  busy.value = true;
  const s = shot;
  try {
    if (!await newSession(chat.project)) throw new Error("Could not start a new session.");
    const stamp = new Date().toISOString().replace(/\W/g, "").slice(0, 15);
    const ctx = { targetSession: null, targetAttachments: composer.attachments };
    await addAttachment(new File([s.png], `snap-${stamp}.png`, { type: "image/png" }), ctx);
    await addAttachment(new File([s.html], `snap-${stamp}-dom.html`, { type: "text/html" }), ctx);
    if (composer.attachments.length < 2) throw new Error("Upload failed.");
    const info = `Page: ${location.pathname}${location.hash}\nViewport: ${innerWidth}x${innerHeight} @${devicePixelRatio}x\nSelection: ${Math.round(s.rect.w)}x${Math.round(s.rect.h)} at (${Math.round(s.rect.x)}, ${Math.round(s.rect.y)})\nRoot element: ${s.target}`;
    const text = `${note.value.trim() || "Fix the issue in this part of Luna's UI."}\n\n[UI snap] The screenshot and the DOM of the selected region are attached.\n${info}`;
    const atts = composer.attachments; composer.attachments = []; composer.text = "";
    cancel();
    await send(text, atts);
  } catch (e) { addErr((e as Error).message); busy.value = false; }
}
function key(e: KeyboardEvent) { if (e.key === "Escape") cancel(); }
onUnmounted(() => { if (preview.value) URL.revokeObjectURL(preview.value); });
</script>

<template>
  <div data-snap-ui>
    <button v-if="mode === 'idle'" type="button" class="snap-tab" aria-label="Snap part of the UI" title="Snap part of the UI" @click="begin"><Crop :size="14" /></button>
    <div v-else-if="mode === 'select'" class="snap-overlay" tabindex="-1" @keydown="key" @pointerdown="down" @pointermove="move" @pointerup="up" @vue:mounted="({ el }: any) => el.focus()">
      <div v-if="box" class="snap-box" :style="box" />
      <div class="snap-hint" @pointerdown.stop>
        <Loader2 v-if="busy" :size="14" class="spin" />
        <span>{{ busy ? "Capturing…" : "Drag to select an area" }}</span>
        <button type="button" class="icon-button" aria-label="Cancel snap" @click="cancel"><X :size="14" /></button>
      </div>
    </div>
    <div v-else class="snap-review" role="dialog" aria-label="Send UI snap" @keydown="key">
      <img :src="preview" alt="Selected area" />
      <textarea v-model="note" rows="3" placeholder="What is wrong? (optional)" class="snap-note" @keydown.ctrl.enter="submit" @keydown.meta.enter="submit" />
      <div class="snap-actions">
        <button type="button" class="snap-btn" @click="cancel">Cancel</button>
        <button type="button" class="snap-btn snap-primary" :disabled="busy" @click="submit"><Loader2 v-if="busy" :size="14" class="spin" /><Send v-else :size="14" /> New session</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.snap-tab { position: fixed; right: 0; top: 55%; z-index: 30; width: 20px; height: 36px; display: grid; place-items: center; border: 1px solid var(--border); border-right: 0; border-radius: 8px 0 0 8px; background: var(--card); color: var(--muted-foreground); opacity: .25; transition: opacity .15s, width .15s; }
.snap-tab:hover, .snap-tab:focus-visible { opacity: 1; width: 30px; color: var(--foreground); }
.snap-overlay { position: fixed; inset: 0; z-index: 90; cursor: crosshair; background: #0000004d; touch-action: none; outline: none; user-select: none; }
.snap-box { position: fixed; border: 2px solid var(--primary); background: #ffffff1a; box-shadow: 0 0 0 9999px #0006; pointer-events: none; }
.snap-hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); font-size: 13px; cursor: default; }
.snap-review { position: fixed; z-index: 90; right: 16px; bottom: 16px; width: min(360px, calc(100vw - 32px)); display: grid; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); box-shadow: 0 12px 40px #0009; }
.snap-review img { max-height: 180px; width: 100%; object-fit: contain; border: 1px solid var(--border); border-radius: 6px; background: var(--background); }
.snap-note { width: 100%; resize: none; padding: 8px; border: 1px solid var(--input); border-radius: 6px; background: var(--background); font-size: 13px; }
.snap-actions { display: flex; justify-content: flex-end; gap: 8px; }
.snap-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; }
.snap-primary { background: var(--primary); color: var(--primary-foreground); border-color: transparent; }
.snap-primary:disabled { opacity: .6; }
</style>
