<script setup lang="ts">
import { ref, watch, onUnmounted } from "vue";
import { ChevronLeft } from "@lucide/vue";
import DiffView from "./DiffView.vue";
import { statusStyle } from "@/lib/diff";
import { isAbortError, type DiffResult, type FileStat } from "./client";

/**
 * Changed files with their diffs. load: fetch one file's diff on demand.
 * Without load, each file carries its patch text (GitHub pull requests).
 */
const props = defineProps<{ files: FileStat[]; load?: (file: FileStat, signal?: AbortSignal) => Promise<DiffResult>; wide: boolean; truncated?: boolean; externalUrl?: string }>();
const selected = ref<FileStat | null>(null), diff = ref<DiffResult | null>(null), loading = ref(false), error = ref<string | null>(null);
let ticket = 0;
let loadController: AbortController | null = null;

function cancelLoad() {
  if (loadController) {
    loadController.abort();
    loadController = null;
  }
}

onUnmounted(() => {
  ticket++;
  cancelLoad();
});

function close() {
  ticket++;
  cancelLoad();
  selected.value = null;
  diff.value = null;
  loading.value = false;
  error.value = null;
}

async function select(file: FileStat) {
  const mine = ++ticket;
  cancelLoad();
  selected.value = file;
  error.value = null;
  diff.value = null;
  if (!props.load) {
    diff.value = file.patch == null ? null : { path: file.path, binary: false, directory: false, text: file.patch, truncated: false };
    loading.value = false;
    return;
  }
  const controller = new AbortController();
  loadController = controller;
  loading.value = true;
  try {
    const d = await props.load(file, controller.signal);
    if (mine === ticket) diff.value = d;
  } catch (e) {
    if (mine === ticket && !isAbortError(e)) error.value = (e as Error).message;
  } finally {
    if (mine === ticket) {
      if (loadController === controller) loadController = null;
      loading.value = false;
    }
  }
}
// A new file set (another commit) clears the selection; "Load more" keeps it.
watch(() => props.files, files => {
  if (selected.value && !files.includes(selected.value)) close();
  // Beside the list there is room for a diff: show the first file instead of an empty pane.
  if (!selected.value && props.wide && files[0]) void select(files[0]);
}, { immediate: true });
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0" :class="wide ? 'flex-row' : 'flex-col'">
    <div class="flex-col min-h-0 overflow-auto text-xs bg-card" :class="[wide ? 'w-64 shrink-0 border-r border-border' : 'flex-1', !wide && selected ? 'hidden' : 'flex']">
      <p class="px-2 py-1.5 text-muted-foreground border-b border-border">{{ files.length }} file{{ files.length === 1 ? '' : 's' }} changed</p>
      <p v-if="!files.length" class="p-3 text-muted-foreground">No file changes.</p>
      <button v-for="file in files" :key="(file.original ?? '') + '\0' + file.path" type="button"
        class="flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-muted min-w-0 vl vl-sm"
        :class="selected === file ? 'bg-accent' : ''"
        :title="file.original ? `${file.original} → ${file.path}` : file.path"
        @click="select(file)">
        <span class="w-3 shrink-0 font-mono font-semibold" :class="statusStyle(file.status).cls" :aria-label="statusStyle(file.status).label">{{ file.status }}</span>
        <span class="truncate flex-1" dir="rtl"><bdi>{{ file.path }}</bdi></span>
        <span v-if="file.binary" class="shrink-0 text-muted-foreground">bin</span>
        <span v-else class="shrink-0 font-mono text-[10px]"><span class="text-emerald-400">+{{ file.additions }}</span> <span class="text-rose-400">-{{ file.deletions }}</span></span>
      </button>
      <p v-if="truncated" class="p-2 text-amber-500">Only the first {{ files.length }} files are listed.</p>
    </div>
    <div class="flex-1 min-h-0 min-w-0 flex-col" :class="!wide && !selected ? 'hidden' : 'flex'">
      <div class="px-2 py-1.5 border-b border-border bg-card text-xs text-muted-foreground flex items-center gap-2 shrink-0 min-w-0">
        <button v-if="!wide" type="button" class="p-1 -ml-1 hover:bg-accent rounded" aria-label="Back to files" @click="close"><ChevronLeft class="w-4 h-4" /></button>
        <span class="truncate">{{ selected ? (selected.original && selected.original !== selected.path ? `${selected.original} → ${selected.path}` : selected.path) : 'No file selected' }}</span>
      </div>
      <div v-if="selected && !load && selected.patch == null" class="flex-1 flex flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
        <span>GitHub does not include this diff. The file is binary or too large.</span>
        <a v-if="externalUrl" :href="externalUrl" target="_blank" rel="noopener noreferrer" class="text-primary underline">Open on GitHub</a>
      </div>
      <div v-else class="flex-1 min-h-0 overflow-hidden">
        <DiffView :diff="diff" :loading="loading" :error="error" />
      </div>
    </div>
  </div>
</template>
