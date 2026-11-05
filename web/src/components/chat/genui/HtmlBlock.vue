<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RotateCw } from "@lucide/vue";
import Block from "./Block.vue";
import { url } from "@/lib/api";
import { MAX_WIDGETS } from "@/lib/segments";
import { routeHtml, sandboxDocument, scrubCssom } from "@/lib/genui/sanitize";
import { sandboxThemeCss } from "@/lib/genui/theme";
import { fillComposer } from "@/stores/composer";

const props = defineProps<{ source: string; closed: boolean; excess?: boolean }>();

const route = computed(() => (props.closed && !props.excess ? routeHtml(props.source) : null));
const error = computed(() => (props.excess ? `Not rendered: more than ${MAX_WIDGETS} ui/html blocks in one message.` : sandboxState.value === "failed" ? "The sandbox did not respond. Check the daemon connection and reload." : ""));

// ---- inline: static markup in a shadow root ----
const host = ref<HTMLElement>();
const HOST_CSS = ":host{display:block;position:relative;contain:layout paint;isolation:isolate;overflow:hidden;color:var(--foreground);font:inherit;line-height:1.5}.luna-doc{min-width:0}.luna-doc [data-luna-prompt]{cursor:pointer}";

// Page CSS often targets html/body/:root, which do not exist in a shadow root. Point those at the wrapper.
function scopeRules(rules: CSSRuleList) {
  for (const rule of rules) {
    if (rule instanceof CSSStyleRule) rule.selectorText = rule.selectorText.replace(/(^|[\s,>+~(])(?::root|html|body)(?![\w-])/g, "$1.luna-doc");
    if ("cssRules" in rule && rule.cssRules) scopeRules(rule.cssRules as CSSRuleList);
  }
}

function mountInline() {
  const r = route.value;
  if (r?.mode !== "inline" || !host.value) return;
  const root = host.value.shadowRoot ?? host.value.attachShadow({ mode: "open" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`${HOST_CSS}\n${r.css}`);
  scopeRules(sheet.cssRules);
  root.adoptedStyleSheets = [sheet];
  const doc = document.createElement("div");
  doc.className = "luna-doc";
  doc.append(r.body.cloneNode(true));
  root.replaceChildren(doc);
  scrubCssom(root);
}

function onInlineClick(e: Event) {
  const target = e.composedPath().find((n): n is Element => n instanceof Element && n.hasAttribute("data-luna-prompt"));
  if (target) fillComposer(target.getAttribute("data-luna-prompt") ?? "");
}

// ---- sandbox: markup with script runs in an opaque-origin frame ----
const frame = ref<HTMLIFrameElement>();
const box = ref<HTMLElement>();
// A frame exists only near the visible part of the transcript. Far frames are removed, so their
// scripts and timers stop; the box keeps its last height so the transcript does not jump.
const near = ref(false);
let observer: IntersectionObserver | undefined;
const generation = ref(0);
const height = ref(120);
const sandboxState = ref<"loading" | "ready" | "failed">("loading");
const previewUrl = computed(() => url("/html-preview"));
let sent = false;
let loadTimer: ReturnType<typeof setTimeout> | undefined;

// Runs first inside the frame: reports its height and exposes luna.prompt(). The frame can only
// suggest text; the parent accepts it on a user gesture and never sends it.
const HELPER = `(() => {
  const post = m => parent.postMessage(m, "*");
  // body, not the root: the root is never shorter than the frame, so the frame could not shrink.
  // Child bounds catch absolute and fixed content that does not add to scrollHeight.
  const size = () => {
    const b = document.body;
    if (!b) return;
    let h = b.scrollHeight;
    for (const el of b.children) h = Math.max(h, el.getBoundingClientRect().bottom + scrollY);
    post({ type: "luna:html-size", height: Math.ceil(h) });
  };
  const ro = new ResizeObserver(size);
  ro.observe(document.documentElement);
  addEventListener("DOMContentLoaded", () => { if (document.body) ro.observe(document.body); size(); });
  addEventListener("load", size);
  window.luna = { prompt: text => post({ type: "luna:prompt", text: String(text) }) };
  addEventListener("click", e => { const el = e.target && e.target.closest && e.target.closest("[data-luna-prompt]"); if (el) window.luna.prompt(el.getAttribute("data-luna-prompt")); });
})();`;

function reload() {
  clearTimeout(loadTimer);
  sent = false;
  sandboxState.value = "loading";
  generation.value++;
  if (route.value?.mode === "sandbox" && near.value) loadTimer = setTimeout(() => { sandboxState.value = "failed"; }, 10_000);
}

function onMessage(event: MessageEvent) {
  if (!frame.value || event.source !== frame.value.contentWindow || event.origin !== "null") return;
  const data = event.data;
  if (data?.type === "luna:html-preview-ready") {
    if (sent || route.value?.mode !== "sandbox") return;
    sent = true;
    clearTimeout(loadTimer);
    sandboxState.value = "ready";
    // The opaque origin cannot be named as a target. Content is sent once per fresh shell.
    frame.value.contentWindow?.postMessage({ type: "luna:html-preview", html: sandboxDocument(props.source, sandboxThemeCss(), HELPER) }, "*");
  } else if (data?.type === "luna:html-size" && typeof data.height === "number" && Number.isFinite(data.height)) {
    height.value = Math.min(1600, Math.max(40, data.height));
  } else if (data?.type === "luna:prompt" && typeof data.text === "string" && navigator.userActivation?.isActive !== false) {
    fillComposer(data.text);
  }
}

watch(route, () => {
  if (route.value?.mode === "sandbox") reload();
  else if (route.value?.mode === "inline") mountInline();
}, { immediate: true, flush: "post" });
watch(previewUrl, reload);
watch(near, reload);
watch(box, (el) => {
  observer?.disconnect();
  observer = undefined;
  if (!el) { near.value = false; return; }
  // The transcript scrolls inside #log; margins on the viewport would be clipped by it.
  observer = new IntersectionObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (entry) near.value = entry.isIntersecting;
  }, { root: el.closest("#log"), rootMargin: "800px 0px" });
  observer.observe(el);
}, { flush: "post" });
onMounted(() => {
  window.addEventListener("message", onMessage);
  mountInline();
});
onUnmounted(() => {
  clearTimeout(loadTimer);
  observer?.disconnect();
  window.removeEventListener("message", onMessage);
});
</script>

<template>
  <Block :source="source" label="HTML" :building="closed ? undefined : 'Building HTML…'" :error="error">
    <template #tools>
      <button v-if="route?.mode === 'sandbox'" type="button" title="Reload" aria-label="Reload HTML" @click="reload"><RotateCw :size="14" /></button>
    </template>
    <div v-if="route?.mode === 'inline'" ref="host" class="html-inline" @click="onInlineClick" />
    <div v-else-if="route?.mode === 'sandbox'" ref="box" class="html-sandbox" :style="{ minHeight: `${height}px` }">
      <p v-if="near && sandboxState === 'loading'" class="pending" role="status">Loading…</p>
      <iframe
        v-if="near"
        :key="generation"
        ref="frame"
        :src="previewUrl"
        :style="{ height: `${height}px` }"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        title="Sandboxed HTML"
      />
    </div>
  </Block>
</template>

<style scoped>
.html-inline { min-width: 0; }
.html-sandbox { position: relative; }
.pending { position: absolute; margin: 0; font-size: 13px; color: var(--muted-foreground); }
iframe { display: block; width: 100%; border: 0; background: transparent; color-scheme: dark; }
</style>
