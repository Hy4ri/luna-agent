<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { FolderKanban, Folder, Code, Terminal, Globe, Smartphone, Layers, Database, BookOpen, Briefcase, FlaskConical, Rocket, Wrench } from "@lucide/vue";
import type { ProjectAppearance, ProjectIcon } from "../../../src/project-appearance";
const props = withDefaults(defineProps<ProjectAppearance & { size?: number; alignLabel?: string }>(), { size: 16 });
const icons: Record<ProjectIcon, unknown> = { folder: Folder, code: Code, terminal: Terminal, globe: Globe, smartphone: Smartphone, layers: Layers, database: Database, "book-open": BookOpen, briefcase: Briefcase, "flask-conical": FlaskConical, rocket: Rocket, wrench: Wrench };

const isBuiltIn = computed(() => !!props.icon && Object.prototype.hasOwnProperty.call(icons, props.icon));
const component = computed(() => {
  if (!props.icon) return FolderKanban;
  return (icons as Record<string, unknown>)[props.icon] ?? FolderKanban;
});

const host = ref<HTMLElement | null>(null);
const labelOffset = ref(0);
const glyph = ref<HTMLCanvasElement | null>(null);
const pixelRatio = 4;
function centerGlyph() {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return;
  labelOffset.value = 0;
  if (props.alignLabel && host.value?.parentElement) {
    const labelStyle = getComputedStyle(host.value.parentElement);
    context.font = `${labelStyle.fontWeight} ${labelStyle.fontSize} ${labelStyle.fontFamily}`;
    const label = context.measureText(props.alignLabel);
    // The baseline sits (font ascent - font descent) / 2 below the line-box center.
    // Subtract the glyph's baseline-to-center distance to find its visible center.
    const offset = (label.fontBoundingBoxAscent - label.fontBoundingBoxDescent
      - label.actualBoundingBoxAscent + label.actualBoundingBoxDescent) / 2;
    labelOffset.value = Number.isFinite(offset) ? offset : 0;
  }
  const canvas = glyph.value;
  if (!canvas || !props.icon) return;
  const style = getComputedStyle(canvas);
  const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  context.font = font;
  const fontSize = parseFloat(style.fontSize);
  const padding = Math.ceil(fontSize * 2);
  // Rasterize with room above and below the baseline. Color emoji font metrics
  // can describe the font cell rather than the pixels that are actually visible.
  context.canvas.width = Math.ceil((context.measureText(props.icon).width + padding * 2) * pixelRatio);
  context.canvas.height = padding * 3 * pixelRatio;
  context.scale(pixelRatio, pixelRatio);
  context.font = font;
  context.fillStyle = style.color;
  context.fillText(props.icon, padding, padding * 2);
  const { width, height } = context.canvas;
  const pixels = context.getImageData(0, 0, width, height).data;
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] === 0) continue;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  const output = canvas.getContext("2d");
  if (!output) return;
  output.clearRect(0, 0, canvas.width, canvas.height);
  if (right < left || bottom < top) return;
  const inkWidth = right - left + 1, inkHeight = bottom - top + 1;
  const scale = Math.min(1, canvas.width / inkWidth, canvas.height / inkHeight);
  const drawWidth = inkWidth * scale, drawHeight = inkHeight * scale;
  // Copy the measured pixels themselves so SVG/HTML emoji fallback cannot
  // introduce a different baseline. Both visible centers land at size / 2.
  output.drawImage(context.canvas, left, top, inkWidth, inkHeight,
    (canvas.width - drawWidth) / 2, (canvas.height - drawHeight) / 2, drawWidth, drawHeight);
}
async function refreshGlyph() {
  centerGlyph();
  if (!glyph.value || !props.icon) return;
  // Canvas does not redraw when a web font arrives. Explicitly load the current
  // glyph, including after an icon change, before measuring its visible pixels.
  const style = getComputedStyle(glyph.value);
  try {
    await document.fonts.load(`${style.fontSize} ${style.fontFamily}`, props.icon);
  } catch { /* Keep system fallback if the font cannot load. */ }
  centerGlyph();
}
watch(() => [props.icon, props.size, props.alignLabel, props.color], refreshGlyph, { flush: "post" });
onMounted(async () => {
  await refreshGlyph();
  await document.fonts.ready;
  centerGlyph();
});
</script>

<template>
  <span ref="host" class="inline-flex shrink-0 items-center justify-center" :style="{ width: `${size}px`, height: `${size}px`, transform: labelOffset ? `translateY(${labelOffset}px)` : undefined }" aria-hidden="true">
  <component :is="component" v-if="!icon || isBuiltIn" :size="size" :style="{ color: color || undefined }" class="shrink-0" aria-hidden="true" />
  <canvas
    v-else ref="glyph"
    :width="size * pixelRatio" :height="size * pixelRatio"
    class="project-custom-icon shrink-0 select-none"
    :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.85)}px`, color: color || undefined }"
    aria-hidden="true"
  />
  </span>
</template>
