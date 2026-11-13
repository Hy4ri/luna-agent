<script setup lang="ts">
import { computed, ref } from 'vue';
import { FilePlus, FileText, Folder, AlertTriangle, Plus, Minus, Undo2 } from '@lucide/vue';
import type { ChangeFile } from './client';
const props = defineProps<{ files: ChangeFile[]; loaded: boolean; untrackedCollapsed: boolean; selectedPath: string | null; selectedStaged: boolean; disabled: boolean }>();
const emit = defineEmits<{ select: [path: string, staged: boolean]; stage: [paths: string[]]; unstage: [paths: string[]]; discard: [paths: string[]] }>();
/** Rows drawn per group before "Show more": keeps huge change sets responsive. */
const PAGE = 300;
const shown = ref<Record<string, number>>({});
const groups = computed(() => [
  { name: 'Conflicts', staged: false, files: props.files.filter(f => f.conflict), action: null },
  { name: 'Staged', staged: true, files: props.files.filter(f => f.staged && !f.conflict), action: 'unstage' as const },
  { name: 'Changes', staged: false, files: props.files.filter(f => !f.untracked && !f.conflict && f.worktree !== '.'), action: 'stage' as const },
  { name: 'Untracked', staged: false, files: props.files.filter(f => f.untracked), action: 'stage' as const },
].filter(group => group.files.length));
function limit(name: string) { return shown.value[name] ?? PAGE; }
function act(action: 'stage' | 'unstage', files: ChangeFile[]) { const paths = files.map(f => f.path); if (action === 'stage') emit('stage', paths); else emit('unstage', paths); }
</script>
<template>
  <div class="h-full overflow-auto text-xs">
    <p v-if="loaded && !groups.length" class="p-4 text-muted-foreground">No changes. The working tree is clean.</p>
    <section v-for="group in groups" :key="group.name" class="p-2 border-b border-border">
      <header class="flex items-center justify-between gap-2 pb-1 text-muted-foreground">
        <h2 class="font-medium">{{ group.name }} ({{ group.files.length }})</h2>
        <button v-if="group.action" type="button" :disabled="disabled" class="underline disabled:opacity-50 max-[760px]:min-h-11" @click="act(group.action, group.files)">{{ group.action === 'stage' ? 'Stage all' : 'Unstage all' }}</button>
        <button v-if="group.action === 'stage'" type="button" :disabled="disabled" class="underline text-destructive disabled:opacity-50 max-[760px]:min-h-11" @click="emit('discard', group.files.map(f => f.path))">Discard all</button>
      </header>
      <p v-if="group.name === 'Untracked' && untrackedCollapsed" class="px-2 pb-1 text-muted-foreground">Too many untracked files: folders are shown as one entry. Ignore build output in .gitignore.</p>
      <div v-for="file in group.files.slice(0, limit(group.name))" :key="file.path" class="flex items-center rounded vl vl-sm" :class="selectedPath === file.path && selectedStaged === group.staged ? 'bg-accent' : ''">
        <button type="button" class="flex flex-1 min-w-0 items-center gap-1.5 px-2 py-1.5 text-left hover:bg-muted" :aria-label="`View ${group.staged ? 'staged' : 'working'} diff ${file.path}`" @click="emit('select', file.path, group.staged)">
          <component :is="file.conflict ? AlertTriangle : file.untracked ? (file.path.endsWith('/') ? Folder : FilePlus) : FileText" :size="14" class="shrink-0" aria-hidden="true" />
          <span class="truncate" :title="file.original ? `${file.original} → ${file.path}` : file.path">{{ file.path }}</span>
        </button>
        <button v-if="group.action === 'stage'" type="button" :disabled="disabled" :aria-label="`Discard changes to ${file.path}`" title="Discard changes" class="p-2 hover:bg-muted text-destructive disabled:opacity-50 max-[760px]:min-h-11 max-[760px]:min-w-11 inline-flex items-center justify-center" @click="emit('discard', [file.path])"><Undo2 :size="14" /></button>
        <button v-if="group.action" type="button" :disabled="disabled" :aria-label="`${group.action === 'stage' ? 'Stage' : 'Unstage'} ${file.path}`" class="p-2 hover:bg-muted disabled:opacity-50 max-[760px]:min-h-11 max-[760px]:min-w-11 inline-flex items-center justify-center" @click="act(group.action, [file])"><component :is="group.action === 'stage' ? Plus : Minus" :size="14" /></button>
      </div>
      <button v-if="group.files.length > limit(group.name)" type="button" class="px-2 py-1.5 underline text-muted-foreground" @click="shown[group.name] = limit(group.name) + PAGE">Show {{ Math.min(PAGE, group.files.length - limit(group.name)) }} more of {{ group.files.length - limit(group.name) }}</button>
    </section>
  </div>
</template>
