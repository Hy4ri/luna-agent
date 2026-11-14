<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { IncrementalMarkdown } from "@/lib/markdown";
import { openImage } from "@/stores/image-viewer";

const props = defineProps<{ content: string; streaming?: boolean }>();
const container = ref<HTMLElement | null>(null);

let inc: IncrementalMarkdown | null = null;
function decorateImages() {
  if (!container.value) return;
  const imgs = container.value.querySelectorAll<HTMLImageElement>("img.md-img, img");
  for (const img of imgs) {
    if (!img.src) continue;
    // Do not interfere with images nested inside links
    if (img.closest("a")) continue;
    if (!img.hasAttribute("role")) img.setAttribute("role", "button");
    if (!img.hasAttribute("tabindex")) img.setAttribute("tabindex", "0");
    if (!img.hasAttribute("aria-label")) {
      const label = img.alt || img.title || "image";
      img.setAttribute("aria-label", `Preview ${label}`);
    }
  }
}

const render = () => {
  if (!container.value) return;
  inc ??= new IncrementalMarkdown(container.value);
  inc.update(props.content || "", !!props.streaming);
  decorateImages();
};

function zoom(e: MouseEvent) {
  const img = e.target instanceof HTMLImageElement ? e.target : null;
  if (!img?.src) return;
  if (img.closest("a")) return;
  e.preventDefault();
  openImage(img.currentSrc || img.src, img.alt);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== "Enter" && e.key !== " ") return;
  const img = e.target instanceof HTMLImageElement ? e.target : null;
  if (!img?.src) return;
  if (img.closest("a")) return;
  e.preventDefault();
  openImage(img.currentSrc || img.src, img.alt);
}

watch(() => [props.content, props.streaming], render);
onMounted(render);
onBeforeUnmount(() => { inc?.dispose(); inc = null; });
</script>

<template>
  <div ref="container" class="md" @click="zoom" @keydown="onKeydown"></div>
</template>

<style scoped>
.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4),
.md :deep(h5),
.md :deep(h6) {
  margin: 1.15em 0 0.4em;
  line-height: 1.35;
  letter-spacing: -0.015em;
  font-weight: 600;
}
.md :deep(h1) { font-size: 1.25em; border-bottom: 1px solid var(--border); padding-bottom: 0.25em; }
.md :deep(h2) { font-size: 1.14em; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); padding-bottom: 0.2em; }
.md :deep(h3) { font-size: 1.05em; }
.md :deep(h4),
.md :deep(h5),
.md :deep(h6) { font-size: 0.96em; color: var(--muted-foreground); }
.md :deep(blockquote) {
  margin: 0.85em 0;
  padding: 10px 14px;
  border-inline-start: 2px solid color-mix(in srgb, var(--primary-text) 55%, var(--border));
  background: color-mix(in srgb, var(--secondary) 40%, transparent);
}
.md :deep(.table-wrap) {
  margin: 0.85em 0;
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.md :deep(.table-wrap table) {
  border: 0;
  font-size: 13.5px;
  font-variant-numeric: tabular-nums;
}
.md :deep(.table-wrap th),
.md :deep(.table-wrap td) {
  padding: 7px 12px;
}
.md :deep(.code-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 34px;
  padding: 5px 12px;
}
.md :deep(.code-lang) {
  line-height: 1;
}
.md :deep(.md-math .katex) {
  font-size: 1em;
}
.md :deep(.code-copy-btn:focus-visible),
.md :deep(.codewrap button:focus-visible),
.md :deep(a:focus-visible),
.md :deep(img[role="button"]:focus-visible) {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
.md :deep(.code-copy-btn),
.md :deep(.codewrap button) {
  color: var(--foreground);
}
@media (max-width: 760px), (pointer: coarse) {
  .md :deep(.code-copy-btn),
  .md :deep(.codewrap button) {
    min-height: 44px;
    min-width: 44px;
    padding: 8px 12px;
  }
  .md :deep(.table-wrap) {
    -webkit-overflow-scrolling: touch;
  }
  .md :deep(.table-wrap th),
  .md :deep(.table-wrap td) {
    padding: 6px 10px;
    font-size: 13.5px;
  }
}
</style>
