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
const glyph = ref<SVGTextElement | null>(null);
const glyphTransform = ref("");
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
  const text = glyph.value;
  if (!text || !props.icon) return;
  const style = getComputedStyle(text);
  context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const bounds = context.measureText(props.icon);
  const { actualBoundingBoxLeft: left, actualBoundingBoxRight: right,
    actualBoundingBoxAscent: ascent, actualBoundingBoxDescent: descent } = bounds;
  // Center the visible glyph, not its font's line box. Fit long text in the icon slot.
  const scale = Math.min(1, props.size / (left + right || 1), props.size / (ascent + descent || 1));
  glyphTransform.value = `translate(${props.size / 2} ${props.size / 2}) scale(${scale}) translate(${(left - right) / 2} ${(ascent - descent) / 2})`;
}
watch(() => [props.icon, props.size, props.alignLabel], centerGlyph, { flush: "post" });
onMounted(async () => {
  centerGlyph();
  await document.fonts.ready;
  centerGlyph();
});
</script>

<template>
  <span ref="host" class="inline-flex shrink-0 items-center justify-center" :style="{ width: `${size}px`, height: `${size}px`, transform: labelOffset ? `translateY(${labelOffset}px)` : undefined }" aria-hidden="true">
  <component :is="component" v-if="!icon || isBuiltIn" :size="size" :style="{ color: color || undefined }" class="shrink-0" aria-hidden="true" />
  <svg
    v-else
    :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`"
    class="shrink-0 select-none overflow-visible"
    :style="{ fontSize: `${Math.round(size * 0.85)}px`, color: color || undefined }"
    aria-hidden="true"
  >
    <text ref="glyph" x="0" y="0" fill="currentColor" :transform="glyphTransform">{{ icon }}</text>
  </svg>
  </span>
</template>
