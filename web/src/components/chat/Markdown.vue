<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { IncrementalMarkdown } from "@/lib/markdown";
import { openImage } from "@/stores/image-viewer";

const props = defineProps<{ content: string }>();
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
  inc.update(props.content || "");
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

watch(() => props.content, render);
onMounted(render);
</script>

<template>
  <div ref="container" class="md" @click="zoom" @keydown="onKeydown"></div>
</template>

<style scoped>
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
