<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue';
import { SquareKanban } from '@lucide/vue';
import { json, post, serverUrl, token } from '@/lib/api';
import { openBoardCard } from '@/stores/app';
const props = defineProps<{ repo: string; number: number; kind: "pr" | "issue" }>();
type Links = { projects: { id: number; name: string }[]; cards: { project: number; id: number; archived: boolean; status: string }[] };
const links = ref<Links>({ projects: [], cards: [] });
const selected = ref<number>(0), loading = ref(false), busy = ref(false), error = ref('');
let generation = 0, disposed = false;
const path = () => `/v1/github/repos/${props.repo}/items/${props.number}`;
watch(() => [props.repo, props.number, props.kind, serverUrl.value, token.value], async () => {
  const ticket = ++generation; links.value = { projects: [], cards: [] }; selected.value = 0; loading.value = true; error.value = '';
  try { const result = await json<Links>(path() + '/cards?kind=' + props.kind); if (ticket !== generation || disposed) return; links.value = result; selected.value = result.projects[0]?.id ?? 0; }
  catch (e) { if (ticket === generation && !disposed) error.value = (e as Error).message; }
  finally { if (ticket === generation && !disposed) loading.value = false; }
}, { immediate: true });
onUnmounted(() => { disposed = true; generation++; });
function existing() { return links.value.cards.find(c => c.project === selected.value); }
async function open() {
  if (busy.value || !selected.value) return;
  const card = existing(); if (card) { openBoardCard(card.project, card.id); return; }
  const ticket = generation, project = selected.value, endpoint = path(); busy.value = true; error.value = '';
  try { const created = await post<{ id: number; archived: boolean }>(endpoint + '/card', { project }); if (ticket !== generation || disposed) return; links.value.cards.push({ ...created, project, status: 'todo' }); openBoardCard(project, created.id); }
  catch (e) { if (ticket === generation && !disposed) error.value = (e as Error).message; }
  finally { busy.value = false; }
}
</script>
<template>
  <div class="flex flex-wrap items-center gap-2 text-xs">
    <select v-if="links.projects.length > 1" v-model="selected" aria-label="Board project" :disabled="busy" class="bg-secondary border border-border rounded px-2 py-1">
      <option v-for="project in links.projects" :key="project.id" :value="project.id">{{ project.name }}</option>
    </select>
    <button type="button" class="inline-flex items-center gap-1.5 border border-border rounded px-2.5 py-1.5 disabled:opacity-50" :disabled="loading || busy || !selected" :title="!loading && !selected ? 'No project uses this repository' : ''" @click="open">
      <SquareKanban :size="14" />
      {{ loading ? 'Loading board…' : busy ? 'Adding…' : existing() ? `Card #${existing()!.id}${existing()!.archived ? ' (archived)' : ''}` : 'Add to board' }}
    </button>
    <span v-if="error" role="alert" class="text-destructive">{{ error }}</span>
  </div>
</template>
