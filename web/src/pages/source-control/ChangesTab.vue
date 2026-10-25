<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed, nextTick } from 'vue';
import { fetchChanges, fetchBranches, fetchDiff, mutateGit } from './client';
import type { Changes, Branches, DiffResult, SelectorParams, ChangeFile } from './client';
import ChangeList from './ChangeList.vue';
import DiffView from './DiffView.vue';
import { GitBranch, RefreshCw, ArrowDown, ArrowUp, AlertCircle, Server, ChevronLeft } from '@lucide/vue';

const props = defineProps<{ session?: string; project?: number; runActive?: boolean }>();
const emit = defineEmits<{ repo: [repo: string | null] }>();
const selector = computed<SelectorParams>(() => ({ session: props.session, project: props.project }));

const changes = ref<Changes | null>(null), branches = ref<Branches | null>(null), diff = ref<DiffResult | null>(null);
const selectedPath = ref<string | null>(null), selectedStaged = ref(false), loadingDiff = ref(false), loadingState = ref(false);
const error = ref<string | null>(null), notice = ref<string | null>(null), busyMessage = ref<string | null>(null);
const commitMessage = ref(''), newBranchInput = ref(''), branchSelectValue = ref(''), showNewBranchInput = ref(false);
const confirmDefaultModal = ref<{ open: boolean; branch?: string; head?: string | null; message?: string }>({ open: false });
const cancelButton = ref<HTMLButtonElement | null>(null), branchInput = ref<HTMLInputElement | null>(null);
/** Branch that was pushed to a non-default remote branch; drives the compare link. */
const pushedBranch = ref<string | null>(null);

const compareUrl = computed(() => changes.value?.repo && pushedBranch.value && pushedBranch.value === changes.value.branch
  ? `https://github.com/${changes.value.repo}/compare/${encodeURIComponent(pushedBranch.value)}?expand=1` : null);
const stagedCount = computed(() => changes.value?.files.filter(f => f.staged).length ?? 0);
const hasConflicts = computed(() => changes.value?.files.some(f => f.conflict) ?? false);
const nothingToPush = computed(() => !!changes.value?.upstream && changes.value.ahead === 0);
const pushTitle = computed(() => !changes.value ? '' : changes.value.detached ? 'Switch to a branch to push'
  : changes.value.unborn ? 'Commit before pushing' : nothingToPush.value ? 'Nothing to push'
  : changes.value.upstream ? `Push to ${changes.value.upstream}` : 'Publish branch');

let epoch = 0, stateTicket = 0, diffTicket = 0, disposed = false, noticeTimer: ReturnType<typeof setTimeout> | undefined;

function showNotice(text: string) {
  notice.value = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.value = null; }, 5000);
}

/** Keep the selected file on the side (staged or working) that still has changes. */
function reconcileSelection(files: ChangeFile[]): boolean {
  const file = files.find(f => f.path === selectedPath.value);
  if (!file) { selectedPath.value = null; diff.value = null; diffTicket++; loadingDiff.value = false; return false; }
  const working = file.untracked || (!file.conflict && file.worktree !== '.');
  if (selectedStaged.value && !file.staged) selectedStaged.value = false;
  else if (!selectedStaged.value && !working && file.staged) selectedStaged.value = true;
  return true;
}

function applyChanges(c: Changes, keepSelection: boolean) {
  changes.value = c;
  branchSelectValue.value = c.branch;
  emit('repo', c.repo);
  if (pushedBranch.value && pushedBranch.value !== c.branch) pushedBranch.value = null;
  if (!keepSelection) { selectedPath.value = null; diff.value = null; diffTicket++; return; }
  if (selectedPath.value && reconcileSelection(c.files)) void loadDiff(selectedPath.value, selectedStaged.value, true);
}

async function loadState(keepSelection = true, clearError = true) {
  const generation = epoch, ticket = ++stateTicket, owner = { ...selector.value };
  loadingState.value = true;
  if (clearError) error.value = null;
  try {
    const [c, b] = await Promise.all([fetchChanges(owner), fetchBranches(owner)]);
    if (disposed || generation !== epoch || ticket !== stateTicket) return;
    branches.value = b;
    applyChanges(c, keepSelection);
  } catch (e) {
    if (!disposed && generation === epoch && ticket === stateTicket) error.value = (e as Error).message;
  } finally {
    if (!disposed && generation === epoch && ticket === stateTicket) loadingState.value = false;
  }
}

async function loadBranches() {
  const generation = epoch, owner = { ...selector.value };
  try { const b = await fetchBranches(owner); if (!disposed && generation === epoch) branches.value = b; } catch { /* the next refresh retries */ }
}

/** quiet: keep the current diff on screen while the refreshed one loads (no flicker). */
async function loadDiff(path: string, staged: boolean, quiet = false) {
  const generation = epoch, ticket = ++diffTicket, owner = { ...selector.value };
  loadingDiff.value = !quiet;
  if (!quiet) diff.value = null;
  try {
    const d = await fetchDiff(owner, path, staged);
    if (!disposed && generation === epoch && ticket === diffTicket) diff.value = d;
  } catch (e) {
    if (!disposed && generation === epoch && ticket === diffTicket) error.value = (e as Error).message;
  } finally {
    if (!disposed && generation === epoch && ticket === diffTicket) loadingDiff.value = false;
  }
}

function handleSelectFile(path: string, staged: boolean) { selectedPath.value = path; selectedStaged.value = staged; void loadDiff(path, staged); }
function closeDiff() { selectedPath.value = null; diff.value = null; diffTicket++; loadingDiff.value = false; }

const BUSY: Record<string, string> = { stage: 'Staging…', unstage: 'Unstaging…', commit: 'Committing…', switch: 'Switching branch…', fetch: 'Fetching…', pull: 'Pulling…', push: 'Pushing…' };
/** Actions that can change branch names, upstreams, or ahead/behind counts. */
const BRANCH_ACTIONS = new Set(['commit', 'switch', 'fetch', 'pull', 'push']);

async function runMutation(action: string, body: Record<string, unknown>, confirmDefault = false) {
  if (loadingState.value || !changes.value) return;
  const generation = epoch, owner = { ...selector.value }, before = changes.value;
  loadingState.value = true; busyMessage.value = BUSY[action] ?? 'Working…'; error.value = null; notice.value = null;
  if (action !== 'push') pushedBranch.value = null;
  let ok = false;
  try {
    const result = await mutateGit(owner, action, {
      ...body,
      ...(action === 'push' ? { expectedBranch: before.branch, expectedHead: before.headOid } : {}),
      ...(confirmDefault ? { confirmDefault: true } : {}),
    });
    if (disposed || generation !== epoch) return;
    ok = true;
    const after = result.changes;
    if (BRANCH_ACTIONS.has(action)) void loadBranches();
    applyChanges(after, action !== 'switch');
    if (action === 'commit') { commitMessage.value = ''; showNotice(`Committed ${result.sha?.slice(0, 7) ?? ''}`.trim()); }
    else if (action === 'fetch') showNotice(after.upstream ? (after.behind ? `Fetched origin: ${after.behind} new commit${after.behind === 1 ? '' : 's'} on ${after.upstream}` : 'Fetched origin: up to date') : 'Fetched origin');
    else if (action === 'pull') showNotice(after.headOid === before.headOid ? 'Already up to date' : `Pulled ${before.upstream}`);
    else if (action === 'switch') showNotice(`Switched to ${after.branch}`);
    else if (action === 'push') {
      // A confirmed push went to the default (or unknown) branch: no compare link for it.
      pushedBranch.value = confirmDefault ? null : after.branch;
      showNotice(`Pushed to ${after.upstream ?? 'origin/' + after.branch}`);
    }
  } catch (e) {
    if (disposed || generation !== epoch) return;
    const message = (e as Error).message;
    const marker = message.indexOf('confirm-default:');
    if (action === 'push' && marker >= 0) {
      confirmDefaultModal.value = { open: true, branch: before.branch, head: before.headOid, message: message.slice(marker + 16).trim() };
      void nextTick(() => cancelButton.value?.focus());
    } else error.value = message;
  } finally {
    if (!disposed && generation === epoch) {
      loadingState.value = false; busyMessage.value = null;
      // A failed write can still have partial effects: reload the real state.
      if (!ok) await loadState(true, false);
    }
  }
}

const handleStage = (paths: string[]) => runMutation('stage', { paths });
const handleUnstage = (paths: string[]) => runMutation('unstage', { paths });
function handleCommit() {
  if (commitMessage.value.trim() && stagedCount.value && !hasConflicts.value) return runMutation('commit', { message: commitMessage.value.trim() });
}
const handleFetch = () => runMutation('fetch', {});
const handlePull = () => runMutation('pull', {});
const handlePush = () => runMutation('push', { setUpstream: !changes.value?.upstream });

async function handleBranchChange(event: Event) {
  const branch = (event.target as HTMLSelectElement).value;
  if (branch === '__new__') {
    showNewBranchInput.value = true; newBranchInput.value = '';
    branchSelectValue.value = changes.value?.branch ?? '';
    void nextTick(() => branchInput.value?.focus());
    return;
  }
  showNewBranchInput.value = false;
  if (branch !== changes.value?.branch) await runMutation('switch', { branch });
}
function cancelNewBranch() { showNewBranchInput.value = false; newBranchInput.value = ''; branchSelectValue.value = changes.value?.branch ?? ''; }
async function handleCreateBranch() {
  if (!newBranchInput.value.trim()) return;
  await runMutation('switch', { branch: newBranchInput.value.trim(), create: true, ...(changes.value?.unborn ? {} : { from: 'HEAD' }) });
  if (!error.value) cancelNewBranch();
}
function handleKeyDownCommit(e: KeyboardEvent) { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void handleCommit(); } }
function closeConfirm() { confirmDefaultModal.value = { open: false }; }
async function confirmAndRetryPush() {
  const target = confirmDefaultModal.value.branch, head = confirmDefaultModal.value.head;
  closeConfirm();
  if (target !== changes.value?.branch || head !== changes.value?.headOid) { error.value = 'Branch changed. Review it before pushing.'; return; }
  await runMutation('push', { setUpstream: !changes.value?.upstream }, true);
}

/** Refresh when the user comes back to the window: agents and terminals change files. */
function refreshIfIdle() { if (!loadingState.value && changes.value && document.visibilityState === 'visible') void loadState(true, false); }
function onKeydown(e: KeyboardEvent) { if (e.key === 'Escape' && confirmDefaultModal.value.open) { e.preventDefault(); closeConfirm(); } }
onMounted(() => { window.addEventListener('focus', refreshIfIdle); document.addEventListener('visibilitychange', refreshIfIdle); window.addEventListener('keydown', onKeydown); });
onUnmounted(() => {
  disposed = true; epoch++; diffTicket++; clearTimeout(noticeTimer);
  window.removeEventListener('focus', refreshIfIdle); document.removeEventListener('visibilitychange', refreshIfIdle); window.removeEventListener('keydown', onKeydown);
});
// A finished agent run has usually changed files.
watch(() => props.runActive, (active, was) => { if (was && !active) refreshIfIdle(); });
watch(() => [props.session, props.project], () => {
  epoch++; stateTicket++; diffTicket++;
  changes.value = null; branches.value = null; diff.value = null; selectedPath.value = null; commitMessage.value = '';
  pushedBranch.value = null; notice.value = null; loadingDiff.value = false; confirmDefaultModal.value = { open: false }; cancelNewBranch();
  void loadState(false);
}, { immediate: true });
</script>

<template>
  <div class="flex flex-col flex-1 min-h-0 bg-background text-foreground overflow-hidden">
    <!-- Toolbar -->
    <div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-border bg-card text-xs shrink-0">
      <div class="flex items-center gap-3 min-w-0 flex-wrap">
        <div class="flex items-center gap-1.5 text-muted-foreground min-w-0" :title="changes ? `Machine ${changes.machine}: ${changes.cwd}` : undefined">
          <Server class="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span class="sr-only">Machine</span>
          <span class="shrink-0">{{ changes?.machine ?? '…' }}</span>
          <span aria-hidden="true">·</span>
          <span class="truncate max-w-[220px] font-mono text-[11px]">{{ changes?.cwd ?? 'Loading…' }}</span>
        </div>

        <div class="flex items-center gap-1">
          <GitBranch class="w-3.5 h-3.5 text-primary shrink-0" aria-hidden="true" />
          <select
            v-model="branchSelectValue"
            aria-label="Branch"
            class="bg-muted border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary max-w-[200px]"
            :disabled="loadingState || !changes"
            @change="handleBranchChange"
          >
            <option v-if="changes?.unborn && !branches?.local.length" :value="changes.branch">{{ changes.branch }} (no commits)</option>
            <option v-if="changes?.detached" value="(detached)">(detached HEAD)</option>
            <optgroup v-if="branches?.local.length" label="Local branches">
              <option v-for="l in branches.local" :key="l.name" :value="l.name">
                {{ l.name }}{{ l.ahead ? ` ↑${l.ahead}` : '' }}{{ l.behind ? ` ↓${l.behind}` : '' }}
              </option>
            </optgroup>
            <optgroup v-if="branches?.remote.length" label="Remote branches">
              <option v-for="r in branches.remote" :key="r" :value="r">{{ r }}</option>
            </optgroup>
            <option value="__new__">+ New branch…</option>
          </select>
        </div>

        <form v-if="showNewBranchInput" class="flex items-center gap-1" @submit.prevent="handleCreateBranch">
          <input
            ref="branchInput"
            v-model="newBranchInput"
            type="text"
            aria-label="New branch name"
            placeholder="branch-name"
            class="bg-muted border border-border rounded px-2 py-1 text-xs text-foreground w-32 focus:outline-none focus:border-primary"
            @keydown.escape.prevent="cancelNewBranch"
          />
          <button type="submit" class="px-2 py-1 text-xs bg-primary text-primary-foreground rounded disabled:opacity-50" :disabled="loadingState || !newBranchInput.trim()">Create</button>
          <button type="button" class="px-2 py-1 text-xs hover:bg-accent rounded" @click="cancelNewBranch">Cancel</button>
        </form>
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        <span v-if="busyMessage" role="status" class="text-muted-foreground">{{ busyMessage }}</span>
        <button
          type="button"
          class="p-1.5 hover:bg-accent rounded text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          aria-label="Refresh Git status"
          title="Refresh Git status"
          :disabled="loadingState"
          @click="loadState(true)"
        >
          <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': loadingState }" />
        </button>
        <button
          type="button"
          class="px-2.5 py-1 bg-card hover:bg-accent border border-border rounded transition-colors disabled:opacity-50"
          :disabled="loadingState || !changes"
          title="Fetch origin"
          @click="handleFetch"
        >
          Fetch
        </button>
        <button
          type="button"
          class="px-2.5 py-1 bg-card hover:bg-accent border border-border rounded transition-colors flex items-center gap-1 disabled:opacity-50"
          :disabled="loadingState || !changes?.upstream"
          :title="changes?.upstream ? `Pull from ${changes.upstream}` : 'Publish branch before pulling'"
          @click="handlePull"
        >
          <ArrowDown class="w-3 h-3" aria-hidden="true" />
          <span>Pull</span>
          <span v-if="changes?.behind" class="text-[10px] bg-primary/20 text-primary px-1 rounded">{{ changes.behind }}</span>
        </button>
        <button
          type="button"
          class="px-2.5 py-1 bg-primary text-primary-foreground hover:bg-primary/90 rounded transition-colors flex items-center gap-1 disabled:opacity-50 disabled:hover:bg-primary"
          :disabled="loadingState || !changes || changes.detached || changes.unborn || nothingToPush"
          :title="pushTitle"
          @click="handlePush"
        >
          <ArrowUp class="w-3 h-3" aria-hidden="true" />
          <span>{{ changes?.upstream ? 'Push' : 'Publish branch' }}</span>
          <span v-if="changes?.ahead" class="text-[10px] bg-background/20 px-1 rounded">{{ changes.ahead }}</span>
        </button>
      </div>
    </div>

    <div v-if="notice || compareUrl" role="status" class="flex items-center gap-3 px-3 py-1.5 text-xs border-b border-border text-muted-foreground shrink-0">
      <span v-if="notice">{{ notice }}</span>
      <a v-if="compareUrl" :href="compareUrl" target="_blank" rel="noopener noreferrer" class="text-primary underline">Open pull request</a>
    </div>
    <div v-if="error" role="alert" class="px-3 py-2 bg-destructive/10 text-destructive text-xs border-b border-border flex items-center justify-between gap-2 shrink-0">
      <div class="flex items-center gap-2 min-w-0">
        <AlertCircle class="w-4 h-4 shrink-0" aria-hidden="true" />
        <span class="whitespace-pre-wrap break-words max-h-32 overflow-auto">{{ error }}</span>
      </div>
      <button type="button" class="text-[11px] underline shrink-0" @click="error = null">Dismiss</button>
    </div>

    <!-- On narrow screens the list and the diff take the full height in turn. -->
    <div class="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden">
      <div class="w-full md:w-80 lg:w-96 flex-col border-r border-border bg-card shrink-0 flex-1 md:flex-none md:h-full min-h-0" :class="selectedPath ? 'hidden md:flex' : 'flex'">
        <div class="flex-1 min-h-0 overflow-hidden">
          <ChangeList
            :disabled="loadingState"
            :loaded="!!changes"
            :files="changes?.files ?? []"
            :untracked-collapsed="changes?.untrackedCollapsed ?? false"
            :selected-path="selectedPath"
            :selected-staged="selectedStaged"
            @select="handleSelectFile"
            @stage="handleStage"
            @unstage="handleUnstage"
          />
        </div>
        <div class="p-2 border-t border-border bg-background shrink-0 space-y-2">
          <textarea
            v-model="commitMessage"
            aria-label="Commit message"
            placeholder="Commit message (Ctrl+Enter to commit)"
            rows="2"
            class="w-full bg-muted border border-border rounded p-2 text-xs text-foreground focus:outline-none focus:border-primary resize-none"
            :disabled="loadingState"
            @keydown="handleKeyDownCommit"
          ></textarea>
          <div class="flex items-center justify-between">
            <span class="text-[11px] text-muted-foreground">{{ hasConflicts ? 'Resolve conflicts to commit' : `${stagedCount} staged` }}</span>
            <button
              type="button"
              class="px-3 py-1 bg-primary text-primary-foreground text-xs rounded hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:hover:bg-primary"
              :disabled="loadingState || !commitMessage.trim() || !stagedCount || hasConflicts"
              @click="handleCommit"
            >
              Commit
            </button>
          </div>
        </div>
      </div>

      <div class="flex-1 min-h-0 flex-col bg-background overflow-hidden" :class="selectedPath ? 'flex' : 'hidden md:flex'">
        <div class="px-3 py-1.5 border-b border-border bg-card text-xs font-medium text-muted-foreground flex items-center gap-2 shrink-0">
          <button v-if="selectedPath" type="button" class="md:hidden p-1 -ml-1 hover:bg-accent rounded" aria-label="Back to changes" @click="closeDiff"><ChevronLeft class="w-4 h-4" /></button>
          <span class="truncate">{{ selectedPath ? `${selectedPath} (${selectedStaged ? 'staged' : 'unstaged'})` : 'No file selected' }}</span>
        </div>
        <div class="flex-1 min-h-0 overflow-hidden">
          <DiffView :diff="diff" :loading="loadingDiff" />
        </div>
      </div>
    </div>

    <div v-if="confirmDefaultModal.open" class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" @click.self="closeConfirm">
      <div role="dialog" aria-modal="true" aria-labelledby="sc-confirm-title" aria-describedby="sc-confirm-text" class="bg-card border border-border rounded-lg max-w-md w-full p-4 space-y-3 shadow-lg">
        <div id="sc-confirm-title" class="flex items-center gap-2 text-amber-500 font-semibold text-sm">
          <AlertCircle class="w-5 h-5" aria-hidden="true" />
          <span>Push to the default branch?</span>
        </div>
        <p id="sc-confirm-text" class="text-xs text-muted-foreground leading-relaxed">{{ confirmDefaultModal.message }}</p>
        <div class="flex justify-end gap-2 pt-2">
          <button ref="cancelButton" type="button" class="px-3 py-1.5 text-xs bg-muted hover:bg-accent rounded border border-border" @click="closeConfirm">Cancel</button>
          <button type="button" class="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90" @click="confirmAndRetryPush">Push</button>
        </div>
      </div>
    </div>
  </div>
</template>
