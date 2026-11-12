<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { FolderKanban, Folder, Code, Terminal, Globe, Smartphone, Layers, Database, BookOpen, Briefcase, FlaskConical, Rocket, Wrench } from "@lucide/vue";
import type { ProjectAppearance, ProjectIcon } from "../../../src/project-appearance";
import { glyphInk, labelCenterOffset } from "@/lib/glyph-ink";
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
  labelOffset.value = 0;
  if (props.alignLabel && host.value?.parentElement) {
    const labelStyle = getComputedStyle(host.value.parentElement);
    labelOffset.value = labelCenterOffset(`${labelStyle.fontWeight} ${labelStyle.fontSize} ${labelStyle.fontFamily}`, props.alignLabel);
  }
  const canvas = glyph.value;
  if (!canvas || !props.icon) return;
  const style = getComputedStyle(canvas);
  const ink = glyphInk(props.icon, `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`, parseFloat(style.fontSize), style.color);
  const output = canvas.getContext("2d");
  if (!output) return;
  output.clearRect(0, 0, canvas.width, canvas.height);
  if (!ink) return;
  const scale = Math.min(1, canvas.width / ink.width, canvas.height / ink.height);
  const drawWidth = ink.width * scale, drawHeight = ink.height * scale;
  // Copy the measured pixels themselves so SVG/HTML emoji fallback cannot
  // introduce a different baseline. Both visible centers land at size / 2.
  output.drawImage(ink.source, ink.left, ink.top, ink.width, ink.height,
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
