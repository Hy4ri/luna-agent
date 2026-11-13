<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ArrowDown, ArrowUp, ChevronRight, CloudOff, GitBranch, FilePlus, FileMinus, FilePen, FileQuestion, FileSymlink, Files, FileWarning, File, SquareArrowOutUpRight } from '@lucide/vue';
import { railCollapsed } from '@/lib/rail-collapse';
import { navigate } from '@/stores/app';
import { chat } from '@/stores/chat';
import { gitStatus as data, registerGitStatusInstance } from '@/stores/git-status';

defineProps<{ docked?: boolean }>();

function fileStatus(status: string) {
  if (status === '??') return { icon: FileQuestion, label: 'Untracked file' };
  if (status.includes('U') || status === 'AA' || status === 'DD') return { icon: FileWarning, label: 'Merge conflict' };
  if (status.includes('R')) return { icon: FileSymlink, label: 'Renamed file' };
  if (status.includes('C')) return { icon: Files, label: 'Copied file' };
  if (status.includes('D')) return { icon: FileMinus, label: 'Deleted file' };
  if (status.includes('A')) return { icon: FilePlus, label: 'Added file' };
  if (status.includes('M')) return { icon: FilePen, label: 'Modified file' };
  if (status.includes('T')) return { icon: FilePen, label: 'File type changed' };
  return { icon: File, label: 'Changed file' };
}

function statusTitle(status: string) {
  const describe = (code: string) => ({ M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', U: 'unmerged' })[code];
  if (status === '??') return 'Untracked file';
  return [fileStatus(status).label, describe(status[0]!) && `Staged: ${describe(status[0]!)}`, describe(status[1]!) && `Unstaged: ${describe(status[1]!)}`].filter(Boolean).join(' · ');
}

function splitPath(path: string) {
  const trimmed = path.replace(/\/$/, '');
  const cut = trimmed.lastIndexOf('/');
  return cut < 0 ? { name: path, dir: '' } : { name: path.slice(cut + 1) || path, dir: trimmed.slice(0, cut) };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const ok = computed(() => data.value?.state === 'ok' ? data.value : null);
// Home directories carry no information here; the full path stays in the tooltip.
const shortCwd = computed(() => chat.cwd?.replace(/^(\/home\/[^/]+|\/root|\/data\/data\/com\.termux\/files\/home)(?=\/|$)/, '~') ?? '');
const changed = computed(() => ok.value ? ok.value.files.length - ok.value.untracked : 0);
const syncTitle = computed(() => {
  const s = ok.value;
  if (!s?.upstream) return 'Branch has no upstream';
  const parts = [s.ahead && `${plural(s.ahead, 'commit')} to push`, s.behind && `${plural(s.behind, 'commit')} to pull`].filter(Boolean);
  return `${parts.length ? parts.join(' · ') : 'Up to date'} · ${s.upstream}`;
});

const root = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | undefined;
let instanceHandle: ReturnType<typeof registerGitStatusInstance> | undefined;

onMounted(() => {
  instanceHandle = registerGitStatusInstance(root);
  observer = new IntersectionObserver(entries => {
    const isVisible = entries.some(e => e.isIntersecting);
    instanceHandle?.setVisible(isVisible);
  });
  // Observe the host container so a hidden Git module can discover a new repository.
  if (root.value?.parentElement) observer.observe(root.value.parentElement);
});

onUnmounted(() => {
  observer?.disconnect();
  instanceHandle?.unregister();
});
</script>
<template>
  <div ref="root" class="git-status-host">
    <section v-if="ok" class="git-status" :class="{ docked }" aria-label="Workspace Git status">
      <div class="git-head">
        <GitBranch :size="14" class="git-head-icon" aria-hidden="true" />
        <span class="git-branch" :title="ok.branch">{{ ok.branch }}</span>
        <span class="git-sync" :title="syncTitle" role="img" :aria-label="syncTitle">
          <CloudOff v-if="!ok.upstream" :size="13" aria-hidden="true" />
          <template v-else>
            <span v-if="ok.ahead" class="git-sync-count"><ArrowUp :size="12" aria-hidden="true" />{{ ok.ahead }}</span>
            <span v-if="ok.behind" class="git-sync-count"><ArrowDown :size="12" aria-hidden="true" />{{ ok.behind }}</span>
          </template>
        </span>
        <button type="button" class="icon-button git-open" aria-label="Open Source Control" title="Open Source Control" @click="navigate('source-control')"><SquareArrowOutUpRight :size="14" /></button>
      </div>
      <p v-if="shortCwd" class="git-cwd truncate font-mono" :title="chat.cwd ?? undefined">{{ shortCwd }}</p>
      <details v-if="ok.files.length" class="git-changes" :open="railCollapsed.git === false" @toggle="railCollapsed.git = !($event.target as HTMLDetailsElement).open">
        <summary>
          <ChevronRight :size="13" class="git-chevron" aria-hidden="true" />
          <span class="git-counts">
            <span v-if="ok.conflicts" class="git-conflicts">{{ plural(ok.conflicts, 'conflict') }}</span>
            <span v-if="changed">{{ changed }} changed</span>
            <span v-if="ok.untracked">{{ ok.untracked }} untracked</span>
          </span>
          <span v-if="ok.added || ok.deleted" class="git-totals" :title="`${plural(ok.added, 'line')} added · ${plural(ok.deleted, 'line')} deleted`"><span class="git-added">+{{ ok.added }}</span><span class="git-deleted">−{{ ok.deleted }}</span></span>
        </summary>
        <ul class="git-files">
          <li v-for="file in ok.files" :key="file.path" :title="file.path">
            <span class="git-file-status" :data-status="file.status === '??' ? 'untracked' : undefined" :title="statusTitle(file.status)" role="img" :aria-label="statusTitle(file.status)"><component :is="fileStatus(file.status).icon" :size="14" aria-hidden="true" /></span>
            <span class="git-path"><span class="git-name">{{ splitPath(file.path).name }}</span><span v-if="splitPath(file.path).dir" class="git-dir">{{ splitPath(file.path).dir }}</span></span>
            <span class="git-file-count">
              <template v-if="file.binary">bin</template>
              <template v-else-if="file.status === '??'">new</template>
              <template v-else><span v-if="file.added" class="git-added">+{{ file.added }}</span><span v-if="file.deleted" class="git-deleted">−{{ file.deleted }}</span></template>
            </span>
          </li>
        </ul>
      </details>
      <p v-else class="git-clean">Working tree clean</p>
    </section>
  </div>
</template>
<style scoped>
.git-status-host { display: contents; }
.git-status { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; min-width: 0; flex-shrink: 0; padding: 0; font-size: 12px; color: var(--muted-foreground); }
.git-status.docked { padding: 10px 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); box-shadow: var(--shadow); }

/* Branch row: the branch name gets the full width and wraps to two lines before it truncates. */
.git-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.git-head :deep(.git-head-icon) { flex-shrink: 0; }
.git-branch {
  flex: 1; min-width: 0; color: var(--foreground); font-weight: 500; line-height: 20px;
  overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden;
}
.git-sync { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; min-height: 20px; font-variant-numeric: tabular-nums; }
.git-sync:empty { display: none; }
.git-sync-count { display: inline-flex; align-items: center; gap: 1px; }
.git-open { width: 28px; height: 28px; margin: 0 -4px 0 0; flex-shrink: 0; }
.git-cwd { margin: 0 0 0 20px; color: var(--muted-foreground); font-size: 11.5px; }

.git-changes summary {
  display: flex; align-items: center; gap: 6px; min-height: 28px; margin-inline: -4px; padding-inline: 4px;
  border-radius: var(--radius); cursor: pointer; list-style: none;
}
.git-changes summary::-webkit-details-marker { display: none; }
.git-changes summary:hover { background: var(--accent); color: var(--foreground); }
.git-changes summary:focus-visible { outline: 2px solid var(--ring); outline-offset: 0; }
.git-changes :deep(.git-chevron) { flex-shrink: 0; transition: transform 120ms; }
.git-changes[open] :deep(.git-chevron) { transform: rotate(90deg); }
.git-counts { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; column-gap: 6px; }
.git-counts > span + span::before { content: '·'; margin-right: 6px; color: var(--faint); }
.git-conflicts { color: var(--destructive); }
.git-clean { margin: 0 0 0 20px; color: var(--faint); }

.git-totals, .git-file-count { display: inline-flex; gap: 6px; flex-shrink: 0; white-space: nowrap; font-variant-numeric: tabular-nums; }
.git-added { color: var(--success); }
.git-deleted { color: var(--destructive); }

.git-files { max-height: 240px; overflow: auto; margin: 4px 0 0; padding: 0; list-style: none; }
.git-files li { display: flex; align-items: center; gap: 6px; min-height: 24px; padding: 2px 0; }
.git-file-status { display: inline-flex; flex-shrink: 0; color: var(--muted-foreground); }
.git-file-status[data-status='untracked'] { color: var(--faint); }
.git-path { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 6px; overflow: hidden; white-space: nowrap; }
.git-name { flex-shrink: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; color: var(--foreground); }
.git-dir { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--faint); font-size: 11px; }
.git-file-count { color: var(--faint); font-size: 11px; }
@media (max-width: 760px), (pointer: coarse) {
  .git-open { min-width: 44px; min-height: 44px; width: 44px; height: 44px; margin: 0 -6px 0 0; }
  .git-changes summary { min-height: 44px; margin-inline: 0; padding-inline: 4px; }
}
@media (prefers-reduced-motion: reduce) { .git-changes :deep(.git-chevron) { transition: none; } }
</style>
