<script setup lang="ts">
// One terminal: the emulator canvas plus its WebSocket. The server keeps the shell alive, so this view can come and go.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { createTerm, type TermHandle } from "@/lib/term-adapter";
import { attachUrl, dropTab, markEnded, setControl, terminal } from "@/stores/terminal";

const props = defineProps<{
  session: string;
  id: string;
  /** Only the visible tab measures, takes focus and reconnects eagerly. */
  active: boolean;
  /** Rewrites typed input, e.g. to apply a sticky Ctrl chip. Return the text to send. */
  transform?: (data: string) => string;
}>();
const emit = defineEmits<{ status: [text: string] }>();

const host = ref<HTMLElement | null>(null);
const note = ref("");
let term: TermHandle | undefined;
let ws: WebSocket | undefined;
let live = false;
let finished = false;
let disposed = false;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let observer: ResizeObserver | undefined;
let frame = 0;
const encoder = new TextEncoder();

function setNote(text: string) { note.value = text; emit("status", text); }

/** While Luna types, the server drops m57's keys and sizes. The view stays read-only and does not reflow her screen. */
const lunaTypes = () => terminal.tabs.find(t => t.id === props.id)?.controller === "agent";

function sendResize() {
  if (lunaTypes()) return;
  if (term && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
}

async function connect() {
  if (disposed || finished) return;
  let url: string;
  try {
    url = await attachUrl(props.session, props.id);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 404) { dropTab(props.id); return; }
    if (status === 403) { finished = true; setNote((e as Error).message); return; }
    schedule();
    return;
  }
  if (disposed) return;
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  ws = socket;
  live = false;
  socket.onopen = () => { retry = 0; setNote(""); };
  socket.onmessage = event => {
    if (typeof event.data !== "string") { term?.write(new Uint8Array(event.data as ArrayBuffer)); return; }
    let msg: { type?: string; exitCode?: number | null; reason?: string; controller?: "user" | "agent"; shared?: boolean };
    try { msg = JSON.parse(event.data); } catch { return; }
    if ((msg.type === "replay-start" || msg.type === "control") && msg.controller) {
      setControl(props.id, msg.controller, !!msg.shared);
      if (msg.type === "control" && msg.controller === "user") sendResize();
    }
    if (msg.type === "replay-start") term?.reset();
    else if (msg.type === "replay-end") { live = true; sendResize(); }
    else if (msg.type === "exit") {
      finished = true;
      markEnded(props.id, msg.exitCode ?? null, msg.reason);
      setNote(msg.reason ?? (msg.exitCode === null || msg.exitCode === undefined ? "The program ended." : `The program exited with code ${msg.exitCode}.`));
    } else if (msg.type === "closed") { finished = true; dropTab(props.id); }
  };
  socket.onclose = () => {
    if (ws === socket) ws = undefined;
    live = false;
    if (!disposed && !finished) { setNote("Disconnected. Reconnecting..."); schedule(); }
  };
  socket.onerror = () => { /* onclose follows and handles the retry */ };
}

function schedule() {
  clearTimeout(retryTimer);
  const delay = Math.min(10_000, 1000 * 2 ** retry++);
  retryTimer = setTimeout(() => void connect(), delay);
}

function send(data: string) {
  if (lunaTypes()) return;
  if (ws?.readyState === WebSocket.OPEN && live) ws.send(encoder.encode(data));
}
/** Input from outside the canvas, such as the mobile key chips. Goes through the same path as typing. */
function sendInput(data: string) { send(data); term?.focus(); }

function fit() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    if (!props.active || !host.value || host.value.clientWidth < 20 || host.value.clientHeight < 20) return;
    term?.fit();
  });
}

onMounted(async () => {
  if (!host.value) return;
  const styles = getComputedStyle(host.value);
  try {
    const created = await createTerm(host.value, { fontSize: parseFloat(styles.fontSize) || 13 });
    if (disposed) { created.dispose(); return; }
    term = created;
  } catch (e) {
    setNote(`The terminal could not start: ${(e as Error).message}`);
    return;
  }
  term.onData(data => send(props.transform ? props.transform(data) : data));
  term.onResponse(send); // Live, human-controlled only; never apply sticky modifiers to protocol replies.
  term.onResize(() => sendResize());
  observer = new ResizeObserver(fit);
  observer.observe(host.value);
  if (props.active) term.focus();
  void connect();
});

watch(() => props.active, active => {
  if (!active) return;
  fit();
  requestAnimationFrame(() => term?.focus());
  if (!ws && !finished && !retryTimer) void connect();
});

onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(retryTimer);
  cancelAnimationFrame(frame);
  observer?.disconnect();
  ws?.close();
  term?.dispose();
});

defineExpose({ sendInput, focus: () => term?.focus() });
</script>

<template>
  <div class="term-view" :hidden="!active">
    <div ref="host" class="term-host" role="application" aria-label="Terminal" />
    <p v-if="note" class="term-note" role="status">{{ note }}</p>
  </div>
</template>

<style scoped>
.term-view { position: relative; display: flex; flex-direction: column; min-height: 0; flex: 1; background: var(--background); }
.term-view[hidden] { display: none; }
.term-host { flex: 1; min-height: 0; overflow: hidden; padding: 4px 6px; font: 13px var(--mono); }
.term-note { margin: 0; padding: 3px 8px; border-top: 1px solid var(--border); background: var(--card); color: var(--muted-foreground); font: 12px var(--mono); }
</style>
