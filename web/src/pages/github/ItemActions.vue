<script setup lang="ts">
import { confirmAction } from "@/lib/confirm";
import { ref, computed, onUnmounted } from 'vue';
import type { RepoInfo, Detail } from '../../../../src/github';
import { post } from '@/lib/api';
import Markdown from '@/components/chat/Markdown.vue';
import MergeDialog from './MergeDialog.vue';
import DeleteIssueDialog from './DeleteIssueDialog.vue';
import MetaPicker from './MetaPicker.vue';
import { editItem } from './client';
import { MessageSquare, GitMerge, Trash2, Pencil } from '@lucide/vue';
const props = defineProps<{ repo: string; detail: Detail; info: RepoInfo }>();
const emit = defineEmits<{ changed: [detail?: Detail]; deleted: [] }>();
const commentBody = ref(''), replyMode = ref<'write' | 'preview'>('write');
const commenting = ref(false), closing = ref(false), merging = ref(false), deletingBranch = ref(false), deletingIssue = ref(false);
const pending = computed(() => commenting.value || closing.value || merging.value || deletingBranch.value || deletingIssue.value);
const commentError = ref<string | null>(null), closeError = ref<string | null>(null), mergeError = ref<string | null>(null), branchDeleteError = ref<string | null>(null), issueDeleteError = ref<string | null>(null);
const issueCloseReason = ref<'completed' | 'not_planned'>('completed');
const editing = ref(false), editTitle = ref(''), editBody = ref(''), editLabels = ref<string[]>([]), editAssignees = ref<string[]>([]), editBusy = ref(false), editError = ref<string | null>(null);
const reviewing = ref(false), reviewBody = ref(''), reviewError = ref<string | null>(null), prBusy = ref(false), prError = ref<string | null>(null);
function startEdit() {
  const d = props.detail; editTitle.value = d.title; editBody.value = d.body; editLabels.value = d.labels.map(l => l.name); editAssignees.value = [...d.assignees]; editError.value = null; editing.value = true;
}
async function saveEdit() {
  if (editBusy.value || !editTitle.value.trim()) return;
  const d = props.detail, same = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x));
  const patch: { kind: 'pr' | 'issue'; title?: string; body?: string; labels?: string[]; assignees?: string[] } = { kind: d.kind };
  if (editTitle.value.trim() !== d.title) patch.title = editTitle.value.trim();
  if (editBody.value !== d.body) patch.body = editBody.value;
  if (!same(editLabels.value, d.labels.map(l => l.name))) patch.labels = editLabels.value;
  if (!same(editAssignees.value, d.assignees)) patch.assignees = editAssignees.value;
  if (Object.keys(patch).length === 1) { editing.value = false; return; }
  editBusy.value = true; editError.value = null;
  try { const updated = await editItem(props.repo, d.number, patch); if (!disposed) { editing.value = false; emit('changed', updated); } }
  catch (e) { if (!disposed) editError.value = message(e); }
  finally { editBusy.value = false; }
}
async function sendReview(event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT') {
  if (reviewing.value || !props.detail.pr) return;
  reviewing.value = true; reviewError.value = null;
  try { const updated = await post<Detail>(endpoint('pulls') + '/review', { event, sha: props.detail.pr.headOid, ...(reviewBody.value.trim() ? { body: reviewBody.value } : {}) }); if (!disposed) { reviewBody.value = ''; emit('changed', updated); } }
  catch (e) { if (!disposed) { reviewError.value = message(e); if ((e as { status?: number }).status === 409) emit('changed'); } }
  finally { reviewing.value = false; }
}
async function prAction(path: 'draft' | 'update-branch', body: Record<string, unknown>) {
  if (prBusy.value || !props.detail.pr) return;
  prBusy.value = true; prError.value = null;
  try { const updated = await post<Detail>(endpoint('pulls') + '/' + path, body); if (!disposed) emit('changed', updated); }
  catch (e) { if (!disposed) { prError.value = message(e); if ((e as { status?: number }).status === 409) emit('changed'); } }
  finally { prBusy.value = false; }
}
const mergeOpen = ref(false), deleteIssueOpen = ref(false);
let disposed = false;
onUnmounted(() => { disposed = true; });
function endpoint(section: 'items' | 'pulls' | 'issues') { return `/v1/github/repos/${props.repo}/${section}/${props.detail.number}`; }
function message(e: unknown) { return (e as Error).message || 'GitHub request failed'; }
async function handleComment() {
  if (pending.value || !commentBody.value.trim() || !props.detail.can.comment) return;
  commenting.value = true; commentError.value = null;
  try { await post(endpoint('items') + '/comments', { body: commentBody.value.trim() }); if (!disposed) { commentBody.value = ''; emit('changed'); } }
  catch (e) { if (!disposed) commentError.value = message(e); }
  finally { commenting.value = false; }
}
async function handleState(state: 'open' | 'closed', reason?: 'completed' | 'not_planned') {
  if (pending.value || !props.detail.can.close) return;
  closing.value = true; closeError.value = null;
  try { const updated = await post<Detail>(endpoint('items') + '/state', { kind: props.detail.kind, state, ...(reason ? { reason } : {}) }); if (!disposed) emit('changed', updated); }
  catch (e) { if (!disposed) closeError.value = message(e); }
  finally { closing.value = false; }
}
async function handleMergeConfirm(method: 'merge' | 'squash' | 'rebase', deleteHeadBranch: boolean) {
  if (pending.value || !props.detail.pr || !props.detail.can.merge) return;
  const sha = props.detail.pr.headOid, path = endpoint('pulls'); merging.value = true; mergeError.value = null;
  let merged: Detail | null = null;
  try {
    merged = await post<Detail>(path + '/merge', { method, sha });
    if (deleteHeadBranch && merged.pr?.branchExists && merged.can.deleteBranch) {
      try { merged = await post<Detail>(path + '/delete-branch', { sha }); }
      catch (e) { if (!disposed) branchDeleteError.value = `Merged, but branch deletion failed: ${message(e)}`; }
    }
    if (!disposed) { mergeOpen.value = false; emit('changed', merged); }
  } catch (e) { if (!disposed) { mergeError.value = message(e); if ((e as {status?:number}).status === 409) { mergeOpen.value = false; emit('changed'); } } }
  finally { merging.value = false; }
}
async function handleDeleteBranch() {
  if (pending.value || !props.detail.pr || !props.detail.can.deleteBranch || !(await confirmAction({ title: `Delete branch '${props.detail.pr.head}'?`, confirmLabel: 'Delete', danger: true }))) return;
  deletingBranch.value = true; branchDeleteError.value = null;
  try { const updated = await post<Detail>(endpoint('pulls') + '/delete-branch', { sha: props.detail.pr.headOid }); if (!disposed) emit('changed', updated); }
  catch (e) { if (!disposed) branchDeleteError.value = message(e); }
  finally { deletingBranch.value = false; }
}
async function handleDeleteIssueConfirm(confirm: number) {
  if (pending.value || confirm !== props.detail.number || !props.detail.can.delete) return;
  deletingIssue.value = true; issueDeleteError.value = null;
  try { await post(endpoint('issues'), { confirm }, 'DELETE'); if (!disposed) { deleteIssueOpen.value = false; emit('deleted'); } }
  catch (e) { if (!disposed) issueDeleteError.value = message(e); }
  finally { deletingIssue.value = false; }
}
</script>

<template>
  <div class="space-y-6 pt-6 border-t border-border/40">
    <!-- Action Bar & Controls -->
    <div class="flex flex-wrap items-center gap-2">
      <!-- Close / Reopen -->
      <template v-if="detail.state === 'OPEN'">
        <!-- Issue close dropdown with reason -->
        <div v-if="detail.kind === 'issue'" class="inline-flex items-center">
          <select
            v-model="issueCloseReason"
            class="bg-background border border-border rounded-l px-2 py-1.5 text-xs text-foreground focus:outline-none"
            :disabled="pending || !detail.can.close"
          >
            <option value="completed">Completed</option>
            <option value="not_planned">Not planned</option>
          </select>
          <button
            type="button"
            class="px-3 py-1.5 bg-secondary hover:bg-secondary/80 text-secondary-foreground text-xs font-medium rounded-r border border-l-0 border-border transition-colors disabled:opacity-50"
            :disabled="pending || !detail.can.close"
            :title="detail.can.close ? 'Close issue' : 'Permission denied to close issue'"
            @click="handleState('closed', issueCloseReason)"
          >
            {{ closing ? 'Closing…' : 'Close issue' }}
          </button>
        </div>

        <!-- PR close button -->
        <button
          v-else
          type="button"
          class="px-3 py-1.5 bg-secondary hover:bg-secondary/80 text-secondary-foreground text-xs font-medium rounded border border-border transition-colors disabled:opacity-50"
          :disabled="pending || !detail.can.close"
          :title="detail.can.close ? 'Close pull request' : 'Permission denied to close pull request'"
          @click="handleState('closed')"
        >
          {{ closing ? 'Closing…' : 'Close PR' }}
        </button>
      </template>

      <!-- Reopen (issues or non-merged PRs) -->
      <template v-else-if="detail.state === 'CLOSED'">
        <button
          type="button"
          class="px-3 py-1.5 bg-secondary hover:bg-secondary/80 text-secondary-foreground text-xs font-medium rounded border border-border transition-colors disabled:opacity-50"
          :disabled="pending || !detail.can.close"
          :title="detail.can.close ? 'Reopen item' : 'Permission denied to reopen item'"
          @click="handleState('open')"
        >
          {{ closing ? 'Reopening…' : 'Reopen' }}
        </button>
      </template>

      <!-- Merge button (PR, OPEN) -->
      <button
        v-if="detail.kind === 'pr' && detail.state === 'OPEN'"
        type="button"
        class="px-3 py-1.5 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-medium rounded transition-colors disabled:opacity-50 flex items-center gap-1.5"
        :disabled="pending || !detail.can.merge"
        :title="detail.can.merge ? 'Merge pull request' : 'PR not mergeable or permission denied'"
        @click="mergeOpen = true"
      >
        <GitMerge class="w-3.5 h-3.5" />
        <span>Merge…</span>
      </button>

      <template v-if="detail.kind === 'pr' && detail.state === 'OPEN' && detail.pr">
        <button type="button" class="px-3 py-1.5 bg-secondary hover:bg-secondary/80 text-secondary-foreground text-xs font-medium rounded border border-border transition-colors disabled:opacity-50" :disabled="pending || prBusy || !detail.can.close" @click="prAction('draft', { draft: !detail.pr.draft })">{{ detail.pr.draft ? 'Ready for review' : 'Convert to draft' }}</button>
        <button v-if="detail.pr.mergeState === 'BEHIND'" type="button" class="px-3 py-1.5 bg-secondary hover:bg-secondary/80 text-secondary-foreground text-xs font-medium rounded border border-border transition-colors disabled:opacity-50" :disabled="pending || prBusy || !detail.can.close" @click="prAction('update-branch', { sha: detail.pr.headOid })">Update branch</button>
      </template>
      <button type="button" class="px-3 py-1.5 bg-secondary hover:bg-secondary/80 text-secondary-foreground text-xs font-medium rounded border border-border transition-colors disabled:opacity-50 flex items-center gap-1.5" :disabled="pending || editing || !detail.can.edit" :title="detail.can.edit ? 'Edit title, description, labels, assignees' : 'Permission denied to edit'" @click="startEdit">
        <Pencil class="w-3.5 h-3.5" /><span>Edit</span>
      </button>

      <!-- Delete Branch button (PR, closed/merged, branch exists) -->
      <button
        v-if="detail.kind === 'pr' && detail.state !== 'OPEN' && detail.pr?.branchExists"
        type="button"
        class="px-3 py-1.5 bg-secondary hover:bg-secondary/80 text-secondary-foreground text-xs font-medium rounded border border-border transition-colors disabled:opacity-50 flex items-center gap-1.5"
        :disabled="pending || !detail.can.deleteBranch"
        :title="detail.can.deleteBranch ? 'Delete head branch' : 'Permission denied or branch missing'"
        @click="handleDeleteBranch"
      >
        <Trash2 class="w-3.5 h-3.5" />
        <span>{{ deletingBranch ? 'Deleting branch…' : 'Delete branch' }}</span>
      </button>

      <!-- Delete Issue button -->
      <button
        v-if="detail.kind === 'issue'"
        type="button"
        class="px-3 py-1.5 bg-destructive/10 hover:bg-destructive/20 text-destructive text-xs font-medium rounded border border-destructive/30 transition-colors disabled:opacity-50 flex items-center gap-1.5 ml-auto"
        :disabled="pending || !detail.can.delete"
        :title="detail.can.delete ? 'Delete issue' : 'Permission denied to delete issue (Admin required)'"
        @click="deleteIssueOpen = true"
      >
        <Trash2 class="w-3.5 h-3.5" />
        <span>Delete issue…</span>
      </button>


    </div>

    <p v-if="prError" role="alert" class="text-xs text-destructive bg-destructive/10 border border-destructive/20 p-3 rounded">{{ prError }}</p>

    <!-- Edit -->
    <div v-if="editing" class="bg-card border border-border rounded-lg p-4 space-y-3">
      <input v-model="editTitle" type="text" maxlength="256" aria-label="Title" class="w-full bg-background border border-border rounded px-3 py-2 text-sm focus:outline-none focus:border-primary" />
      <textarea v-model="editBody" rows="6" aria-label="Description" class="w-full bg-background border border-border rounded p-3 text-sm font-mono resize-y focus:outline-none focus:border-primary"></textarea>
      <MetaPicker v-model:labels="editLabels" v-model:assignees="editAssignees" :repo="repo" with-assignees />
      <p v-if="editError" role="alert" class="text-xs text-destructive">{{ editError }}</p>
      <div class="flex justify-end gap-2">
        <button type="button" class="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent" :disabled="editBusy" @click="editing = false">Cancel</button>
        <button type="button" class="px-3 py-1.5 bg-primary text-primary-foreground text-xs font-medium rounded disabled:opacity-50" :disabled="editBusy || !editTitle.trim()" @click="saveEdit">{{ editBusy ? 'Saving…' : 'Save' }}</button>
      </div>
    </div>

    <!-- Review -->
    <div v-if="detail.kind === 'pr' && detail.state === 'OPEN' && detail.pr" class="bg-card border border-border rounded-lg p-4 space-y-2">
      <h4 class="text-xs font-medium uppercase tracking-wider">Review</h4>
      <textarea v-model="reviewBody" rows="2" placeholder="Review comment (required to request changes or comment)" aria-label="Review comment" class="w-full bg-background border border-border rounded p-2 text-sm focus:outline-none focus:border-primary resize-y"></textarea>
      <div class="flex flex-wrap gap-2">
        <button type="button" class="px-3 py-1.5 text-xs rounded border border-green-400/40 text-green-400 hover:bg-green-400/10 disabled:opacity-50" :disabled="reviewing" @click="sendReview('APPROVE')">Approve</button>
        <button type="button" class="px-3 py-1.5 text-xs rounded border border-destructive/40 text-destructive hover:bg-destructive/10 disabled:opacity-50" :disabled="reviewing || !reviewBody.trim()" @click="sendReview('REQUEST_CHANGES')">Request changes</button>
        <button type="button" class="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent disabled:opacity-50" :disabled="reviewing || !reviewBody.trim()" @click="sendReview('COMMENT')">Comment</button>
      </div>
      <p v-if="reviewError" role="alert" class="text-xs text-destructive">{{ reviewError }}</p>
    </div>

    <!-- Error Banners -->
    <div v-if="closeError || mergeError || branchDeleteError || issueDeleteError" class="text-xs text-destructive bg-destructive/10 border border-destructive/20 p-3 rounded space-y-1">
      <p>{{ closeError || mergeError || branchDeleteError || issueDeleteError }}</p>
    </div>

    <!-- Reply Box -->
    <div class="bg-card border border-border rounded-lg p-4 space-y-3">
      <div class="flex items-center justify-between border-b border-border/40 pb-2">
        <h4 class="text-xs font-medium uppercase tracking-wider flex items-center gap-1.5">
          <MessageSquare class="w-3.5 h-3.5" />
          <span>Leave a reply</span>
        </h4>
        <div class="flex items-center gap-1 bg-muted rounded p-0.5 text-xs">
          <button
            type="button"
            class="px-2 py-1 rounded transition-colors"
            :class="replyMode === 'write' ? 'bg-background text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'"
            @click="replyMode = 'write'"
          >
            Write
          </button>
          <button
            type="button"
            class="px-2 py-1 rounded transition-colors"
            :class="replyMode === 'preview' ? 'bg-background text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'"
            @click="replyMode = 'preview'"
          >
            Preview
          </button>
        </div>
      </div>

      <div v-if="replyMode === 'write'" class="space-y-2">
        <textarea
          v-model="commentBody"
          rows="4"
          placeholder="Leave a comment using safe Markdown…"
          class="w-full bg-background border border-border rounded p-3 text-sm text-foreground focus:outline-none focus:border-primary resize-y font-mono"
          :disabled="pending"
        ></textarea>
      </div>
      <div v-else class="bg-background border border-border rounded p-3 min-h-[100px] text-sm">
        <Markdown :content="commentBody.trim() || '*Nothing to preview.*'" />
      </div>

      <div class="flex items-center justify-between pt-1">
        <span class="text-xs text-muted-foreground">GitHub Flavored Markdown is supported.</span>
        <button
          type="button"
          class="px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-medium rounded transition-colors disabled:opacity-50"
          :disabled="!commentBody.trim() || pending || !detail.can.comment"
          :title="detail.can.comment ? 'Post comment' : 'Permission denied to comment'"
          @click="handleComment"
        >
          {{ commenting ? 'Posting…' : 'Comment' }}
        </button>
      </div>

      <div v-if="commentError" class="text-xs text-destructive bg-destructive/10 p-2 rounded">
        {{ commentError }}
      </div>
    </div>

    <!-- Modals -->
    <MergeDialog
      v-if="detail.kind === 'pr' && detail.pr"
      v-model:open="mergeOpen"
      :detail="detail"
      :info="info"
      :busy="merging"
      :error="mergeError"
      @confirm="handleMergeConfirm"
    />

    <DeleteIssueDialog
      v-if="detail.kind === 'issue'"
      v-model:open="deleteIssueOpen"
      :detail="detail"
      :busy="deletingIssue"
      :error="issueDeleteError"
      @confirm="handleDeleteIssueConfirm"
    />
  </div>
</template>
