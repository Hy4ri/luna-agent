<script setup lang="ts">
import { computed } from "vue";
import { FolderKanban, Folder, Code, Terminal, Globe, Smartphone, Layers, Database, BookOpen, Briefcase, FlaskConical, Rocket, Wrench } from "@lucide/vue";
import type { ProjectAppearance, ProjectIcon } from "../../../src/project-appearance";
const props = withDefaults(defineProps<ProjectAppearance & { size?: number }>(), { size: 16 });
const icons: Record<ProjectIcon, unknown> = { folder: Folder, code: Code, terminal: Terminal, globe: Globe, smartphone: Smartphone, layers: Layers, database: Database, "book-open": BookOpen, briefcase: Briefcase, "flask-conical": FlaskConical, rocket: Rocket, wrench: Wrench };

const isBuiltIn = computed(() => !!props.icon && Object.prototype.hasOwnProperty.call(icons, props.icon));
const component = computed(() => {
  if (!props.icon) return FolderKanban;
  return (icons as Record<string, unknown>)[props.icon] ?? FolderKanban;
});
</script>

<template>
  <component :is="component" v-if="!icon || isBuiltIn" :size="size" :style="{ color: color || undefined }" class="shrink-0" aria-hidden="true" />
  <span
    v-else
    class="inline-flex shrink-0 select-none items-center justify-center leading-none text-center"
    :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.85)}px`, color: color || undefined }"
    aria-hidden="true"
  >{{ icon }}</span>
</template>
