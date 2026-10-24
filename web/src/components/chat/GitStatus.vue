<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { GitBranch } from '@lucide/vue';
import { chat } from '@/stores/chat';
import { json, serverUrl } from '@/lib/api';
import type { GitStatus } from '../../../../src/git-status';
defineProps<{ docked?: boolean }>();
const data = ref<GitStatus | null>(null);
const root = ref<HTMLElement | null>(null);
let visible = false, generation = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let observer: IntersectionObserver | undefined;
let controller: AbortController | undefined;
async function refresh() {
  if (!visible || document.hidden || !chat.session || controller) return;
  const sid = chat.session, epoch = chat.epoch, own = generation;
  const request = new AbortController(); controller = request;
  try {
    const result = await json<GitStatus>(`/v1/sessions/${sid}/git`, { signal: request.signal });
    if (own === generation && sid === chat.session && epoch === chat.epoch) data.value = result;
  } catch (e) {
    if (own === generation && !request.signal.aborted) data.value = { state: 'error', message: (e as Error).message };
  } finally { if (controller === request) controller = undefined; }
}
function reset() {
  generation++; controller?.abort(); controller = undefined; data.value = null; void refresh();
}
watch([() => chat.session, () => chat.cwd, () => chat.machine?.id, serverUrl], reset);
function visibility() { if (document.hidden) { controller?.abort(); controller = undefined; } else void refresh(); }
onMounted(() => {
  observer = new IntersectionObserver(entries => { visible = entries.some(e => e.isIntersecting); if (visible) void refresh(); });
  if (root.value) observer.observe(root.value);
  timer = setInterval(refresh, 5000);
  window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', visibility);
});
onUnmounted(() => {
  generation++; controller?.abort(); observer?.disconnect(); clearInterval(timer);
  window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visibility);
});
</script>
<template>
  <section ref="root" class="git-status" :class="{ 'card': docked }" aria-label="Workspace Git status">
    <details>
      <summary>
        <span class="git-branch"><GitBranch :size="14" aria-hidden="true" /><span class="truncate" :title="data?.state === 'ok' ? data.branch : 'Git'">{{ data?.state === 'ok' ? data.branch : 'Git' }}</span></span>
        <span v-if="data?.state === 'ok' && data.files.length" class="git-totals"><span class="git-added">+{{ data.added }}</span> <span class="git-deleted">−{{ data.deleted }}</span></span>
      </summary>
      <p class="git-caption">Workspace changes · staged and unstaged</p>
      <ul v-if="data?.state === 'ok' && data.files.length" class="git-files">
        <li v-for="file in data.files" :key="file.path"><code>{{ file.status }}</code><span class="git-path" :title="file.path">{{ file.path }}</span><span class="git-file-count">{{ file.binary ? 'Binary' : file.status === '??' ? 'Untracked' : `+${file.added} −${file.deleted}` }}</span></li>
      </ul>
    </details>
    <template v-if="data?.state === 'ok'">
      <p class="git-caption">{{ data.files.length ? `${data.files.length - data.untracked} changed · ${data.untracked} untracked` : 'Working tree clean' }}<span v-if="data.conflicts" class="text-destructive"> · {{ data.conflicts }} conflicts</span></p>
      <p v-if="data.upstream && (data.ahead || data.behind)" class="git-caption" :title="data.upstream">{{ data.ahead }} ahead · {{ data.behind }} behind</p>
    </template>
    <p v-else class="git-caption" :role="data?.state === 'error' ? 'status' : undefined">{{ data?.message ?? 'Reading Git status…' }}</p>
  </section>
</template>
<style scoped>
.git-status { min-width: 0; padding: 10px 12px; font-size: 12px; }
summary { cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 28px; }
summary:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.git-branch { display: flex; align-items: center; gap: 6px; min-width: 0; }
.git-branch svg { flex-shrink: 0; }
.git-totals, .git-file-count { white-space: nowrap; font-variant-numeric: tabular-nums; }
.git-added { color: #86c995; } .git-deleted { color: #ef9a9a; }
.git-caption { color: var(--muted-foreground); margin: 4px 0 0; }
.git-files { max-height: 240px; overflow: auto; margin-top: 8px; }
.git-files li { display: flex; gap: 6px; padding: 4px 0; align-items: baseline; }
.git-path { flex: 1; min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.git-file-count { color: var(--muted-foreground); }
</style>
