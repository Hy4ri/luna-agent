<script setup lang="ts">
import { computed } from "vue";
import { FolderKanban, Folder, Code, Terminal, Globe, Smartphone, Layers, Database, BookOpen, Briefcase, FlaskConical, Rocket, Wrench } from "@lucide/vue";
import type { ProjectAppearance, ProjectIcon } from "../../../src/project-appearance";
const props = withDefaults(defineProps<ProjectAppearance & { size?: number }>(), { size: 16 });
const icons = { folder: Folder, code: Code, terminal: Terminal, globe: Globe, smartphone: Smartphone, layers: Layers, database: Database, "book-open": BookOpen, briefcase: Briefcase, "flask-conical": FlaskConical, rocket: Rocket, wrench: Wrench } satisfies Record<ProjectIcon, unknown>;
const component = computed(() => props.icon ? icons[props.icon] ?? FolderKanban : FolderKanban);
</script>

<template>
  <component :is="component" :size="size" :style="{ color: color || undefined }" class="shrink-0" aria-hidden="true" />
</template>
