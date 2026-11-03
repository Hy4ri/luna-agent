<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { GitBranch, FilePlus, FileMinus, FilePen, FileQuestion, FileSymlink, Files, FileWarning, File } from '@lucide/vue';
import { railCollapsed } from '@/lib/rail-collapse';
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
    <section v-if="data?.state === 'ok'" class="git-status" :class="{ 'card': docked }" aria-label="Workspace Git status">
      <details :open="railCollapsed.git === false" @toggle="railCollapsed.git = !($event.target as HTMLDetailsElement).open">
        <summary>
          <span class="git-branch"><GitBranch :size="14" aria-hidden="true" /><span class="truncate" :title="data?.state === 'ok' ? data.branch : 'Git'">{{ data?.state === 'ok' ? data.branch : 'Git' }}</span></span>
          <span v-if="data?.state === 'ok' && data.files.length" class="git-totals"><span class="git-added">+{{ data.added }}</span> <span class="git-deleted">−{{ data.deleted }}</span></span>
        </summary>
        <ul v-if="data?.state === 'ok' && data.files.length" class="git-files">
          <li v-for="file in data.files" :key="file.path"><span class="git-file-status" :title="statusTitle(file.status)" role="img" :aria-label="statusTitle(file.status)"><component :is="fileStatus(file.status).icon" :size="14" aria-hidden="true" /></span><span class="git-path" :title="file.path">{{ file.path }}</span><span class="git-file-count">{{ file.binary ? 'Binary' : file.status === '??' ? 'Untracked' : `+${file.added} −${file.deleted}` }}</span></li>
        </ul>
      </details>
      <template v-if="data?.state === 'ok'">
        <p v-if="chat.cwd" class="git-caption truncate font-mono" :title="chat.cwd">{{ chat.cwd }}</p>
        <p class="git-caption">{{ data.files.length ? `${data.files.length - data.untracked} changed · ${data.untracked} untracked` : 'Working tree clean' }}<span v-if="data.conflicts" class="text-destructive"> · {{ data.conflicts }} conflicts</span></p>
        <p v-if="data.upstream && (data.ahead || data.behind)" class="git-caption" :title="data.upstream">{{ data.ahead }} ahead · {{ data.behind }} behind</p>
      </template>
    </section>
  </div>
</template>
<style scoped>
.git-status-host { display: contents; }
.git-status { min-width: 0; flex-shrink: 0; padding: 10px 12px; font-size: 12px; }
.git-status:not(.card) { padding-inline: max(24px, calc((100% - 760px) / 2)); }
@media (max-width: 760px) {
  .git-status:not(.card) { padding-inline: 16px; }
}
summary { cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 28px; }
summary:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.git-branch { display: flex; align-items: center; gap: 6px; min-width: 0; }
.git-branch svg { flex-shrink: 0; }
.git-totals, .git-file-count { flex-shrink: 0; white-space: nowrap; font-variant-numeric: tabular-nums; }
.git-added { color: #86c995; } .git-deleted { color: #ef9a9a; }
.git-caption { color: var(--muted-foreground); margin: 4px 0 0; }
.git-files { max-height: 240px; overflow: auto; margin-top: 8px; }
.git-files li { display: flex; gap: 6px; padding: 4px 0; align-items: baseline; }
.git-file-status { display: inline-flex; flex-shrink: 0; align-self: center; color: var(--muted-foreground); }
.git-path { flex: 1; min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.git-file-count { color: var(--muted-foreground); }
</style>
