<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed, nextTick } from 'vue';
import { serverUrl, token } from '@/lib/api';
import { fetchChanges, fetchBranches, fetchStashes, fetchDiff, fetchCommit, draftCommitMessage, commitDraftAvailable, mutateGit, isAbortError } from './client';
import { confirmAction } from '@/lib/confirm';
import type { StashEntry, Changes, Branches, DiffResult, SelectorParams, ChangeFile } from './client';
import ChangeList from './ChangeList.vue';
import StashList from './StashList.vue';
import DiffView from './DiffView.vue';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { GitBranch, RefreshCw, ArrowDown, ArrowUp, AlertCircle, Server, ChevronLeft } from '@lucide/vue';

const props = defineProps<{ session?: string; project?: number; machine?: string; runActive?: boolean }>();
const emit = defineEmits<{ repo: [repo: string | null]; count: [files: number] }>();
const selector = computed<SelectorParams>(() => ({ session: props.session, project: props.project, machine: props.machine }));

const changes = ref<Changes | null>(null), branches = ref<Branches | null>(null), diff = ref<DiffResult | null>(null);
const selectedPath = ref<string | null>(null), selectedStaged = ref(false), loadingDiff = ref(false), loadingState = ref(false);
const error = ref<string | null>(null), notice = ref<string | null>(null), busyMessage = ref<string | null>(null);
const amend = ref(false);
const draftAvailable = ref(false), drafting = ref(false);
void commitDraftAvailable().then(v => { draftAvailable.value = v; });
async function handleDraft() {
  if (drafting.value || !stagedCount.value) return;
  const owner = { ...selector.value }, generation = epoch;
  drafting.value = true; error.value = null;
  try {
    const message = await draftCommitMessage(owner);
    if (!disposed && generation === epoch) commitMessage.value = message;
  } catch (e) { if (!disposed && generation === epoch) error.value = (e as Error).message; }
  finally { if (!disposed && generation === epoch) drafting.value = false; }
}
const commitMessage = ref(''), newBranchInput = ref(''), branchSelectValue = ref(''), showNewBranchInput = ref(false);
const pushButton = ref<HTMLButtonElement | null>(null);
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
let stateController: AbortController | null = null;
let diffController: AbortController | null = null;
let branchesController: AbortController | null = null;

function cancelState() {
  if (stateController) {
    stateController.abort();
    stateController = null;
  }
}

function cancelDiff() {
  if (diffController) {
    diffController.abort();
    diffController = null;
  }
}

function showNotice(text: string) {
  notice.value = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.value = null; }, 5000);
}

/** Keep the selected file on the side (staged or working) that still has changes. */
function reconcileSelection(files: ChangeFile[]): boolean {
  const file = files.find(f => f.path === selectedPath.value);
  if (!file) {
    selectedPath.value = null;
    diff.value = null;
    diffTicket++;
    cancelDiff();
    loadingDiff.value = false;
    return false;
  }
  const working = file.untracked || (!file.conflict && file.worktree !== '.');
  if (selectedStaged.value && !file.staged) selectedStaged.value = false;
  else if (!selectedStaged.value && !working && file.staged) selectedStaged.value = true;
  return true;
}

function applyChanges(c: Changes, keepSelection: boolean) {
  changes.value = c;
  branchSelectValue.value = c.branch;
  emit('repo', c.repo); emit('count', c.files.length);
  if (pushedBranch.value && pushedBranch.value !== c.branch) pushedBranch.value = null;
  if (!keepSelection) {
    selectedPath.value = null;
    diff.value = null;
    diffTicket++;
    cancelDiff();
    loadingDiff.value = false;
    return;
  }
  if (selectedPath.value && reconcileSelection(c.files)) void loadDiff(selectedPath.value, selectedStaged.value, true);
}

async function loadState(keepSelection = true, clearError = true) {
  cancelState();
  const generation = epoch, ticket = ++stateTicket, owner = { ...selector.value };
  const controller = new AbortController();
  stateController = controller;
  loadingState.value = true;
  if (clearError) error.value = null;
  try {
    const [c, b] = await Promise.all([fetchChanges(owner, controller.signal), fetchBranches(owner, controller.signal)]);
    if (disposed || generation !== epoch || ticket !== stateTicket) return;
    branches.value = b; void loadStashes();
    applyChanges(c, keepSelection);
  } catch (e) {
    if (!disposed && generation === epoch && ticket === stateTicket && !isAbortError(e)) {
      error.value = (e as Error).message;
    }
  } finally {
    if (!disposed && generation === epoch && ticket === stateTicket) {
      if (stateController === controller) stateController = null;
      loadingState.value = false;
    }
  }
}

const stashes = ref<StashEntry[]>([]);
async function loadStashes() {
  const generation = epoch, owner = { ...selector.value };
  try { const list = await fetchStashes(owner); if (!disposed && generation === epoch) stashes.value = list; } catch { /* stashes are optional */ }
}
async function loadBranches() {
  if (disposed) return;
  branchesController?.abort();
  const controller = branchesController = new AbortController();
  const generation = epoch, owner = { ...selector.value };
  try { const b = await fetchBranches(owner, controller.signal); if (!disposed && generation === epoch && !controller.signal.aborted) branches.value = b; } catch { /* the next refresh retries */ }
  finally { if (branchesController === controller) branchesController = null; }
}

/** quiet: keep the current diff on screen while the refreshed one loads (no flicker). */
async function loadDiff(path: string, staged: boolean, quiet = false) {
  cancelDiff();
  const generation = epoch, ticket = ++diffTicket, owner = { ...selector.value };
  const controller = new AbortController();
  diffController = controller;
  loadingDiff.value = !quiet;
  if (!quiet) diff.value = null;
  try {
    const d = await fetchDiff(owner, path, staged, controller.signal);
    if (!disposed && generation === epoch && ticket === diffTicket) diff.value = d;
  } catch (e) {
    if (!disposed && generation === epoch && ticket === diffTicket && !isAbortError(e)) {
      error.value = (e as Error).message;
    }
  } finally {
    if (!disposed && generation === epoch && ticket === diffTicket) {
      if (diffController === controller) diffController = null;
      loadingDiff.value = false;
    }
  }
}

function handleSelectFile(path: string, staged: boolean) { selectedPath.value = path; selectedStaged.value = staged; void loadDiff(path, staged); }
function closeDiff() {
  selectedPath.value = null;
  diff.value = null;
  diffTicket++;
  cancelDiff();
  loadingDiff.value = false;
}

const BUSY: Record<string, string> = { discard: 'Discarding…', stash: 'Stashing…', 'stash-pop': 'Applying stash…', 'stash-drop': 'Dropping stash…', stage: 'Staging…', unstage: 'Unstaging…', commit: 'Committing…', switch: 'Switching branch…', fetch: 'Fetching…', pull: 'Pulling…', push: 'Pushing…' };
/** Actions that can change branch names, upstreams, or ahead/behind counts. */
const BRANCH_ACTIONS = new Set(['commit', 'switch', 'fetch', 'pull', 'push']);

let pendingAmend = false;
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
    if (action.startsWith('stash')) void loadStashes();
    applyChanges(after, action !== 'switch');
    if (action === 'commit') { commitMessage.value = ''; amend.value = false; showNotice(`Committed ${result.sha?.slice(0, 7) ?? ''}`.trim()); }
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
    } else if (action === 'commit' && message.includes('confirm-amend:')) {
      pendingAmend = true;
    } else error.value = message;
  } finally {
    if (!disposed && generation === epoch) {
      loadingState.value = false; busyMessage.value = null;
      // A failed write can still have partial effects: reload the real state.
      if (!ok) await loadState(true, false);
      if (pendingAmend) { pendingAmend = false; void confirmAmend(); }
    }
  }
}

/** The server accepts 500 paths per request; a larger selection stages or unstages everything. */
const MAX_PATHS = 500;
const handleStage = (paths: string[]) => runMutation('stage', paths.length > MAX_PATHS ? { all: true } : { paths });
const handleUnstage = (paths: string[]) => runMutation('unstage', paths.length > MAX_PATHS ? { all: true } : { paths });
const canCommit = computed(() => !!commitMessage.value.trim() && !hasConflicts.value && (amend.value ? !!changes.value?.headOid : stagedCount.value > 0));
async function toggleAmend() {
  if (!amend.value) return;
  const oid = changes.value?.headOid, owner = { ...selector.value }, generation = epoch;
  if (!oid) { amend.value = false; return; }
  // Start from the last message, but never overwrite one the user already typed.
  if (commitMessage.value.trim()) return;
  try {
    const detail = await fetchCommit(owner, oid);
    if (!disposed && generation === epoch && amend.value && !commitMessage.value.trim()) commitMessage.value = detail.message.trim();
  } catch (e) { if (!disposed && generation === epoch) { error.value = (e as Error).message; amend.value = false; } }
}
async function handleDiscard(paths: string[]) {
  const what = paths.length === 1 ? `'${paths[0]}'` : `${paths.length} files`;
  if (!(await confirmAction({ title: `Discard changes to ${what}?`, message: 'This cannot be undone. Untracked files are deleted.', confirmLabel: 'Discard', danger: true }))) return;
  await runMutation('discard', paths.length > MAX_PATHS ? { paths: paths.slice(0, MAX_PATHS) } : { paths });
}
const handleStash = () => runMutation('stash', { includeUntracked: true });
const handleStashPop = (index: number) => runMutation('stash-pop', { index });
async function handleStashDrop(index: number) {
  if (await confirmAction({ title: 'Drop this stash?', message: 'The stashed changes are lost.', confirmLabel: 'Drop', danger: true })) await runMutation('stash-drop', { index });
}
async function handleCommit() {
  if (!canCommit.value || loadingState.value) return;
  const message = commitMessage.value.trim();
  if (!amend.value) return runMutation('commit', { message });
  await runMutation('commit', { message, amend: true });
}
/** Amending a commit origin already has needs a second, explicit yes. */
async function confirmAmend() {
  const message = commitMessage.value.trim();
  if (!(await confirmAction({ title: 'Amend a pushed commit?', message: 'This commit is already on origin. Amending rewrites it, and the next push needs force.', confirmLabel: 'Amend', danger: true }))) return;
  await runMutation('commit', { message, amend: true, force: true });
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
onMounted(() => { window.addEventListener('focus', refreshIfIdle); document.addEventListener('visibilitychange', refreshIfIdle); });
onUnmounted(() => {
  disposed = true; epoch++; diffTicket++; stateTicket++; clearTimeout(noticeTimer);
  cancelState();
  cancelDiff();
  branchesController?.abort();
  window.removeEventListener('focus', refreshIfIdle); document.removeEventListener('visibilitychange', refreshIfIdle);
});
// A finished agent run has usually changed files.
watch(() => props.runActive, (active, was) => { if (was && !active) refreshIfIdle(); });
watch(() => [props.session, props.project, props.machine, serverUrl.value, token.value], () => {
  epoch++; stateTicket++; diffTicket++;
  cancelState();
  cancelDiff();
  branchesController?.abort();
  changes.value = null; branches.value = null; diff.value = null; selectedPath.value = null; commitMessage.value = ''; amend.value = false;
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
            class="bg-muted border border-border rounded px-2 py-1 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1 focus:border-primary max-w-[200px]"
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
            class="bg-muted border border-border rounded px-2 py-1 text-xs text-foreground w-32 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1 focus:border-primary"
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
          class="p-1.5 hover:bg-accent rounded text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 max-[760px]:min-h-11 max-[760px]:min-w-11 inline-flex items-center justify-center focus-visible:outline-2 focus-visible:outline-ring"
          aria-label="Refresh Git status"
          title="Refresh Git status"
          :disabled="loadingState"
          @click="loadState(true)"
        >
          <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': loadingState }" />
        </button>
        <button
          type="button"
          class="px-2.5 py-1 bg-card hover:bg-accent border border-border rounded transition-colors disabled:opacity-50 max-[760px]:min-h-11"
          :disabled="loadingState || !changes"
          title="Fetch origin"
          @click="handleFetch"
        >
          Fetch
        </button>
        <button
          type="button"
          class="px-2.5 py-1 bg-card hover:bg-accent border border-border rounded transition-colors flex items-center gap-1 disabled:opacity-50 max-[760px]:min-h-11"
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
          class="px-2.5 py-1 bg-primary text-primary-foreground hover:bg-primary/90 rounded transition-colors flex items-center gap-1 disabled:opacity-50 disabled:hover:bg-primary max-[760px]:min-h-11"
          :disabled="loadingState || !changes || changes.detached || changes.unborn || nothingToPush"
          :title="pushTitle"
          ref="pushButton"
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
            @discard="handleDiscard"
          />
        </div>
        <div class="p-2 border-t border-border bg-background shrink-0 space-y-2">
          <div class="flex items-center justify-between gap-2">
            <StashList :stashes="stashes" :disabled="loadingState" @pop="handleStashPop" @drop="handleStashDrop" />
            <button type="button" class="text-[11px] underline text-muted-foreground disabled:opacity-50 disabled:no-underline ml-auto" :disabled="loadingState || !(changes?.files.length) || changes?.unborn" title="Save all changes, including untracked files, and clean the tree" @click="handleStash">Stash changes</button>
          </div>
          <textarea
            v-model="commitMessage"
            aria-label="Commit message"
            placeholder="Commit message (Ctrl+Enter to commit)"
            rows="2"
            class="w-full bg-muted border border-border rounded p-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1 focus:border-primary resize-none"
            :disabled="loadingState"
            @keydown="handleKeyDownCommit"
          ></textarea>
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3 min-w-0">
              <span class="text-[11px] text-muted-foreground">{{ hasConflicts ? 'Resolve conflicts to commit' : `${stagedCount} staged` }}</span>
              <button v-if="draftAvailable" type="button" class="text-[11px] underline text-muted-foreground disabled:opacity-50 disabled:no-underline" :disabled="loadingState || drafting || !stagedCount" :title="stagedCount ? 'Ask the auxiliary model for a message. Uses one model call.' : 'Stage changes first'" @click="handleDraft">{{ drafting ? 'Drafting…' : 'Draft message' }}</button>
              <label v-if="changes?.headOid" class="flex items-center gap-1 text-[11px] text-muted-foreground cursor-pointer">
                <input v-model="amend" type="checkbox" :disabled="loadingState" @change="toggleAmend" /> Amend last commit
              </label>
            </div>
            <button
              type="button"
              class="px-3 py-1 bg-primary text-primary-foreground text-xs rounded hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:hover:bg-primary"
              :disabled="loadingState || !canCommit"
              @click="handleCommit"
            >
              {{ amend ? 'Amend' : stagedCount ? `Commit ${stagedCount} file${stagedCount === 1 ? '' : 's'}` : 'Commit' }}
            </button>
          </div>
        </div>
      </div>

      <div class="flex-1 min-h-0 flex-col bg-background overflow-hidden" :class="selectedPath ? 'flex' : 'hidden md:flex'">
        <div class="px-3 py-1.5 border-b border-border bg-card text-xs font-medium text-muted-foreground flex items-center gap-2 shrink-0">
          <button v-if="selectedPath" type="button" class="md:hidden p-1 -ml-1 hover:bg-accent rounded max-[760px]:min-h-11 max-[760px]:min-w-11 inline-flex items-center justify-center focus-visible:outline-2 focus-visible:outline-ring" aria-label="Back to changes" @click="closeDiff"><ChevronLeft class="w-4 h-4" /></button>
          <span class="truncate">{{ selectedPath ? `${selectedPath} (${selectedStaged ? 'staged' : 'unstaged'})` : 'No file selected' }}</span>
        </div>
        <div class="flex-1 min-h-0 overflow-hidden">
          <DiffView :diff="diff" :loading="loadingDiff" />
        </div>
      </div>
    </div>

    <Dialog :open="confirmDefaultModal.open" @update:open="(val) => { if (!val) closeConfirm(); }">
      <DialogContent class="max-w-md bg-card border border-border p-4 space-y-3" :show-close-button="false" @close-auto-focus.prevent="pushButton?.focus()">
        <DialogHeader class="space-y-1">
          <DialogTitle class="flex items-center gap-2 text-amber-500 font-semibold text-sm">
            <AlertCircle class="w-5 h-5" aria-hidden="true" />
            <span>Push to the default branch?</span>
          </DialogTitle>
          <DialogDescription class="text-xs text-muted-foreground leading-relaxed">
            {{ confirmDefaultModal.message }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter class="flex justify-end gap-2 pt-2 sm:space-x-0">
          <button ref="cancelButton" type="button" class="px-3 py-1.5 text-xs bg-muted hover:bg-accent rounded border border-border" @click="closeConfirm">Cancel</button>
          <button type="button" class="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90" @click="confirmAndRetryPush">Push</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
