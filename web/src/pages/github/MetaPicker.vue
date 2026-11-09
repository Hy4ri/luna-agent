<script setup lang="ts">
// Label and assignee toggles loaded from the repository. Picks only; the parent saves.
import { ref, watch } from "vue";
import { fetchLabels, fetchAssignees } from "./client";
const props = defineProps<{ repo: string; labels: string[]; assignees: string[]; withAssignees?: boolean }>();
const emit = defineEmits<{ "update:labels": [string[]]; "update:assignees": [string[]] }>();
const allLabels = ref<{ name: string; color: string }[]>([]), allAssignees = ref<string[]>([]), error = ref("");
watch(() => props.repo, async repo => {
  error.value = "";
  try {
    const [l, a] = await Promise.all([fetchLabels(repo), props.withAssignees ? fetchAssignees(repo) : Promise.resolve({ assignees: [] })]);
    if (repo === props.repo) { allLabels.value = l.labels; allAssignees.value = a.assignees; }
  } catch (e) { if (repo === props.repo) error.value = (e as Error).message; }
}, { immediate: true });
const flip = (list: string[], v: string) => list.includes(v) ? list.filter(x => x !== v) : [...list, v];
</script>

<template>
  <div class="space-y-2 text-xs">
    <p v-if="error" class="text-destructive">{{ error }}</p>
    <fieldset v-if="allLabels.length" class="space-y-1">
      <legend class="text-muted-foreground mb-1">Labels</legend>
      <div class="flex flex-wrap gap-1">
        <button v-for="l in allLabels" :key="l.name" type="button" :aria-pressed="labels.includes(l.name)"
          class="px-2 py-0.5 rounded border" :class="labels.includes(l.name) ? 'bg-secondary text-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'"
          @click="emit('update:labels', flip(labels, l.name))">
          <span class="inline-block w-2 h-2 rounded-full mr-1" :style="{ backgroundColor: '#' + l.color }"></span>{{ l.name }}
        </button>
      </div>
    </fieldset>
    <fieldset v-if="withAssignees && allAssignees.length" class="space-y-1">
      <legend class="text-muted-foreground mb-1">Assignees</legend>
      <div class="flex flex-wrap gap-1">
        <button v-for="a in allAssignees" :key="a" type="button" :aria-pressed="assignees.includes(a)"
          class="px-2 py-0.5 rounded border" :class="assignees.includes(a) ? 'bg-secondary text-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'"
          @click="emit('update:assignees', flip(assignees, a))">@{{ a }}</button>
      </div>
    </fieldset>
  </div>
</template>
