<script setup lang="ts">
import { computed } from "vue";
import { Server, FolderGit2, GitPullRequest as Github } from "@lucide/vue";

export type MachineChoice = { value: string; label: string; online: boolean };
const props = defineProps<{
  /** Set when a chat session is open: the session decides the target and the pickers are read-only. */
  sessionTarget: { machine: string; cwd: string } | null;
  projects: { id: number; name: string }[];
  project: number | null;
  machines: MachineChoice[];
  machine: string;
  repos: { repo: string; projects: { id: number }[] }[];
  /** The GitHub repository shown by Pull requests and Issues. */
  repo: string;
  /** Repository of the local checkout, when known. */
  localRepo: string | null;
  showRepo: boolean;
  showCustom: boolean;
  customInput: string;
  customError: string;
}>();
const emit = defineEmits<{
  "update:project": [id: number | null];
  "update:machine": [value: string];
  "update:customInput": [value: string];
  repoChange: [value: string];
  confirmCustom: [];
}>();
const known = computed(() => props.repos.some(r => r.repo === props.repo));
const select = "bg-muted border border-border rounded px-2 py-1 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1 focus:border-primary max-w-[200px]";
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5 border-b border-border bg-card text-xs shrink-0" role="group" aria-label="Source Control target">
    <div v-if="sessionTarget" class="flex items-center gap-1.5 text-muted-foreground min-w-0" :title="`Current session: ${sessionTarget.machine}: ${sessionTarget.cwd}`">
      <Server class="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span class="shrink-0">Session · {{ sessionTarget.machine }}</span>
      <span class="truncate max-w-[260px] font-mono text-[11px]">{{ sessionTarget.cwd }}</span>
    </div>
    <template v-else>
      <label class="flex items-center gap-1.5 text-muted-foreground">
        <FolderGit2 class="w-3.5 h-3.5" aria-hidden="true" /><span class="sr-only">Project</span>
        <select :value="project ?? ''" aria-label="Source Control project" :class="select" @change="emit('update:project', ($event.target as HTMLSelectElement).value === '' ? null : Number(($event.target as HTMLSelectElement).value))">
          <option v-if="!projects.length" value="">No project with a directory</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </label>
      <label v-if="machines.length > 1 || machines.some(m => !m.online)" class="flex items-center gap-1.5 text-muted-foreground">
        <Server class="w-3.5 h-3.5" aria-hidden="true" /><span class="sr-only">Machine</span>
        <select :value="machine" aria-label="Source Control machine" :class="select" @change="emit('update:machine', ($event.target as HTMLSelectElement).value)">
          <option value="">Automatic</option>
          <option v-for="m in machines" :key="m.value" :value="m.value" :disabled="!m.online">{{ m.label }}{{ m.online ? '' : ' (offline)' }}</option>
        </select>
      </label>
    </template>
    <label v-if="showRepo" class="flex items-center gap-1.5 text-muted-foreground">
      <Github class="w-3.5 h-3.5" aria-hidden="true" /><span class="sr-only">GitHub repository</span>
      <select :value="showCustom ? '__custom__' : repo" aria-label="GitHub repository" :class="select" @change="emit('repoChange', ($event.target as HTMLSelectElement).value)">
        <option v-if="repo && !known" :value="repo">{{ repo }}</option>
        <option v-for="r in repos" :key="r.repo" :value="r.repo">{{ r.repo }}</option>
        <option value="__custom__">Other repository…</option>
      </select>
    </label>
    <span v-else-if="localRepo" class="flex items-center gap-1.5 text-muted-foreground" title="Origin of this checkout"><Github class="w-3.5 h-3.5" aria-hidden="true" />{{ localRepo }}</span>
    <form v-if="showRepo && showCustom" class="flex items-center gap-1" @submit.prevent="emit('confirmCustom')">
      <input :value="customInput" type="text" placeholder="owner/repo" aria-label="Repository owner/name" class="bg-muted border border-border rounded px-2 py-1 text-xs text-foreground w-36 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1 focus:border-primary" @input="emit('update:customInput', ($event.target as HTMLInputElement).value)" />
      <button type="submit" class="px-2 py-1 text-xs bg-primary text-primary-foreground rounded">Go</button>
      <span v-if="customError" role="alert" class="text-destructive">{{ customError }}</span>
    </form>
  </div>
</template>
