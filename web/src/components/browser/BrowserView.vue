<script setup lang="ts">
// One browser tab: a canvas that draws the frames the server pushes, and your pointer and keys sent back while you drive.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { applyMeta, browser, browserAttachUrl, dropBrowserTab } from "@/stores/browser";
import { toPagePoint } from "@/lib/browser-view";

const props = defineProps<{ session: string; tabId: string; active: boolean }>();
const emit = defineEmits<{ status: [text: string] }>();

const canvas = ref<HTMLCanvasElement | null>(null);
const note = ref("");
const hasFrame = ref(false);
let ws: WebSocket | undefined;
let disposed = false, retry = 0, finished = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let pending: ImageBitmap | undefined;
let raf = 0;
let page = { width: 0, height: 0 };

const info = () => browser.tabs.find(t => t.tabId === props.tabId);
const driving = () => !!info()?.input;
function setNote(text: string) { note.value = text; emit("status", text); }

function draw() {
  raf = 0;
  const c = canvas.value;
  if (!c || !pending) return;
  if (c.width !== pending.width || c.height !== pending.height) { c.width = pending.width; c.height = pending.height; }
  c.getContext("2d")?.drawImage(pending, 0, 0);
  pending.close();
  pending = undefined;
  hasFrame.value = true;
}
async function onFrame(buf: ArrayBuffer) {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(new Blob([buf])); } catch { return; }
  if (disposed) { bitmap.close(); return; }
  pending?.close();
  pending = bitmap;
  if (!raf) raf = requestAnimationFrame(draw);
}

async function connect() {
  if (disposed || finished) return;
  let url: string;
  try { url = await browserAttachUrl(props.session, props.tabId); }
  catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 404) { dropBrowserTab(props.tabId); return; }
    if (status === 403) { finished = true; setNote((e as Error).message); return; }
    schedule(); return;
  }
  if (disposed) return;
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  ws = socket;
  socket.onopen = () => { retry = 0; setNote(""); };
  socket.onmessage = event => {
    if (typeof event.data !== "string") { void onFrame(event.data as ArrayBuffer); return; }
    let msg: { type?: string; width?: number; height?: number; url?: string; controller?: "user" | "agent"; input?: boolean; live?: boolean; message?: string };
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === "meta") {
      page = { width: msg.width ?? 0, height: msg.height ?? 0 };
      applyMeta(props.tabId, { ...(msg.url ? { url: msg.url } : {}), ...(msg.controller ? { controller: msg.controller } : {}), ...(msg.input !== undefined ? { input: msg.input } : {}), ...(msg.live !== undefined ? { live: msg.live } : {}) });
    } else if (msg.type === "closed") { finished = true; dropBrowserTab(props.tabId); }
    else if (msg.type === "error") setNote(msg.message ?? "Browser error.");
  };
  socket.onclose = () => {
    if (ws === socket) ws = undefined;
    if (!disposed && !finished) { setNote("Disconnected. Reconnecting..."); schedule(); }
  };
  socket.onerror = () => { /* onclose follows and handles the retry */ };
}
function schedule() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void connect(), Math.min(10_000, 1000 * 2 ** retry++));
}

function send(event: Record<string, unknown>) {
  if (driving() && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", event }));
}
function point(e: { clientX: number; clientY: number }) {
  const c = canvas.value;
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return toPagePoint(e.clientX, e.clientY, { left: r.left, top: r.top, width: r.width, height: r.height }, { width: c.width, height: c.height }, page);
}
const buttons = ["left", "middle", "right"] as const;
let moveFrame = 0, lastMove: { x: number; y: number } | undefined;
function onPointerDown(e: PointerEvent) {
  canvas.value?.focus();
  const p = point(e);
  if (!p || !driving()) return;
  canvas.value?.setPointerCapture(e.pointerId);
  send({ kind: "mouse", type: "down", ...p, button: buttons[e.button] ?? "left", clickCount: e.detail || 1 });
}
function onPointerUp(e: PointerEvent) {
  const p = point(e);
  if (!p) return;
  send({ kind: "mouse", type: "up", ...p, button: buttons[e.button] ?? "left", clickCount: e.detail || 1 });
}
function onPointerMove(e: PointerEvent) {
  if (!driving()) return;
  const p = point(e);
  if (!p) return;
  lastMove = p;
  if (moveFrame) return;
  moveFrame = requestAnimationFrame(() => { moveFrame = 0; if (lastMove) send({ kind: "mouse", type: "move", ...lastMove }); });
}
function onWheel(e: WheelEvent) {
  if (!driving()) return;
  const p = point(e);
  if (!p) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  send({ kind: "wheel", ...p, deltaX: e.deltaX * unit, deltaY: e.deltaY * unit });
}
function onKey(e: KeyboardEvent, type: "down" | "up") {
  if (!driving() || e.isComposing) return;
  // Escape leaves the page so the keyboard is never trapped; Ctrl+` stays the app's terminal shortcut.
  if (e.key === "Escape") { if (type === "down") canvas.value?.blur(); return; }
  if (e.code === "Backquote" && e.ctrlKey) return;
  e.preventDefault();
  send({ kind: "key", type, key: e.key });
}

onMounted(() => { canvas.value?.addEventListener("wheel", onWheel, { passive: false }); void connect(); });
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(retryTimer);
  cancelAnimationFrame(raf);
  cancelAnimationFrame(moveFrame);
  pending?.close();
  ws?.close();
  canvas.value?.removeEventListener("wheel", onWheel);
});
watch(() => props.active, active => { if (active && !ws && !finished && !retryTimer) void connect(); });
defineExpose({ focus: () => canvas.value?.focus(), sendNav: (event: Record<string, unknown>) => send(event) });
</script>

<template>
  <div class="browser-view" :hidden="!active">
    <canvas ref="canvas" class="browser-canvas" :class="{ driving: driving() }" tabindex="0" role="application" :aria-label="`Browser tab ${info()?.url ?? ''}`"
      @pointerdown="onPointerDown" @pointerup="onPointerUp" @pointermove="onPointerMove" @contextmenu.prevent
      @keydown="onKey($event, 'down')" @keyup="onKey($event, 'up')" />
    <p v-if="!hasFrame && !note" class="browser-note">Waiting for the page...</p>
    <p v-if="note" class="browser-note" role="status">{{ note }}</p>
  </div>
</template>

<style scoped>
.browser-view { position: relative; display: flex; flex: 1; min-height: 0; min-width: 0; background: color-mix(in srgb, black 25%, var(--background)); }
.browser-view[hidden] { display: none; }
.browser-canvas { width: 100%; height: 100%; object-fit: contain; outline: none; cursor: default; touch-action: none; }
.browser-canvas.driving { cursor: crosshair; }
.browser-canvas:focus-visible { outline: 1px solid var(--ring); outline-offset: -1px; }
.browser-note { position: absolute; inset: auto 0 0; margin: 0; padding: 4px 10px; font: 12px var(--mono); color: var(--muted-foreground); background: var(--card); border-top: 1px solid var(--border); }
</style>
