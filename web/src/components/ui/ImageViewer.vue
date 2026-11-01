<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import { Download, ExternalLink, X } from "@lucide/vue";
import { closeImage, imageViewer } from "@/stores/image-viewer";

const open = computed({ get: () => !!imageViewer.src, set: v => { if (!v) closeImage(); } });
const natural = ref(false);
const dragY = ref(0);
watch(open, () => { natural.value = false; dragY.value = 0; });

// Swipe down to close. Ignored while zoomed, multi-touch (pinch), or scrolled.
const pointers = new Set<number>();
let startY = 0, pinched = false;
function down(e: PointerEvent) {
  pointers.add(e.pointerId);
  if (pointers.size > 1) { pinched = true; dragY.value = 0; return; }
  pinched = false;
  startY = e.clientY;
}
function move(e: PointerEvent) {
  if (e.pointerType !== "touch" || pinched || natural.value || !pointers.has(e.pointerId)) return;
  dragY.value = Math.max(0, e.clientY - startY);
}
function up(e: PointerEvent) {
  pointers.delete(e.pointerId);
  if (pointers.size) return;
  const far = dragY.value > 80 && !pinched;
  dragY.value = 0;
  if (far) closeImage();
}
function stageClick(e: MouseEvent) {
  if (e.target === e.currentTarget) closeImage();
}
// Blob and data URLs: data: cannot be opened as a top-level page in most browsers, so convert first.
async function openOriginal() {
  let url = imageViewer.src;
  if (url.startsWith("data:")) url = URL.createObjectURL(await (await fetch(url)).blob());
  window.open(url, "_blank", "noopener");
}
// Download via blob + <a download>. Works for blob:, data:, and same-origin URLs, on desktop and mobile browsers.
async function download() {
  try {
    const blob = await (await fetch(imageViewer.src)).blob();
    const ext = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as Record<string, string>)[blob.type] ?? "png";
    const base = (imageViewer.alt || "image").replace(/\.(png|jpe?g|gif|webp)$/i, "").replace(/[^\w.-]+/g, "_").slice(0, 80) || "image";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch {
    void openOriginal();
  }
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="iv-overlay" />
      <DialogContent class="iv-content" @open-auto-focus.prevent>
        <DialogTitle class="sr-only">Image viewer</DialogTitle>
        <DialogDescription class="sr-only">{{ imageViewer.alt || "Image" }}</DialogDescription>
        <div class="iv-bar">
          <button type="button" class="iv-btn" aria-label="Download image" title="Download image" @click="download"><Download :size="18" aria-hidden="true" /></button>
          <button type="button" class="iv-btn" aria-label="Open original" title="Open original" @click="openOriginal"><ExternalLink :size="18" aria-hidden="true" /></button>
          <DialogClose class="iv-btn" aria-label="Close image" title="Close"><X :size="18" aria-hidden="true" /></DialogClose>
        </div>
        <div class="iv-stage" :class="{ natural }" @click="stageClick" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up">
          <img class="iv-img" :class="{ natural }" :src="imageViewer.src" :alt="imageViewer.alt" :style="dragY ? { transform: `translateY(${dragY}px)`, opacity: 1 - Math.min(dragY / 300, 0.5) } : undefined" draggable="false" @click.stop="natural = !natural" />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style>
.iv-overlay { position: fixed; inset: 0; z-index: 60; background: color-mix(in srgb, var(--background) 92%, black); }
.iv-content { position: fixed; inset: 0; z-index: 61; outline: none; }
.iv-bar { position: absolute; z-index: 1; top: max(8px, env(safe-area-inset-top)); right: max(8px, env(safe-area-inset-right)); display: flex; gap: 4px; }
.iv-btn { display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: var(--radius); background: var(--card); border: 1px solid var(--border); color: var(--foreground); }
.iv-btn:hover { background: var(--secondary); }
.iv-stage { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; overflow: hidden; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); touch-action: pinch-zoom; }
.iv-stage.natural { overflow: auto; display: block; }
.iv-img { max-width: 100vw; max-height: 100dvh; object-fit: contain; cursor: zoom-in; touch-action: pinch-zoom; user-select: none; }
.iv-img.natural { max-width: none; max-height: none; cursor: zoom-out; margin: auto; }
.iv-stage.natural .iv-img { display: block; }
</style>
