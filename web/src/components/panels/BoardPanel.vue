<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { Archive, ArrowLeft, GripVertical, Plus, Search, RefreshCw, X, LockKeyhole, ArrowUp, ArrowDown, ChevronsUp, Minus, UserRound, Check, CircleAlert, ArrowRight } from '@lucide/vue';
import { json, post } from '@/lib/api';
import { history } from '@/stores/sessions';
import { chat } from '@/stores/chat';
import { boardChanged, openPanel, ui } from '@/stores/app';
import type { Project } from '@/lib/types';

type Status = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';
type Priority = 'low' | 'medium' | 'high' | 'urgent';
type Card = { id: number; project: number; subject: string; description: string; status: Status; priority: Priority; owner: string | null; blocked: string | null; labels: string[]; blockedBy: number[]; archived: boolean; created: number; updated: number };
const columns: [Status, string][] = [['backlog', 'Backlog'], ['todo', 'To do'], ['in_progress', 'In progress'], ['review', 'Review'], ['done', 'Done']];
const priorities: Priority[] = ['low', 'medium', 'high', 'urgent'];
const cards = ref<Card[]>([]), selectedPid = ref(''), archived = ref(false);
const loading = ref(true), busy = ref(false), error = ref(''), notice = ref('');
const search = ref(''), priority = ref('');
const editing = ref(false), editingId = ref<number | null>(null), editingArchived = ref(false);
const form = reactive({ subject: '', description: '', priority: 'medium' as Priority, status: 'backlog' as Status, owner: '', labels: '', blockedBy: '' });
const answer = ref(''), activity = ref<{ id: number; at: number; by: string; text: string }[]>([]);
const board = ref<HTMLElement>(), editorTitle = ref<HTMLInputElement>();
let generation = 0, disposed = false, controller: AbortController | undefined, refreshQueued = false;
let editorReturn: HTMLElement | null = null;
const visible = computed(() => cards.value.filter(c => (!priority.value || c.priority === priority.value) && `${c.subject} ${c.description} ${c.labels.join(' ')} ${c.owner || ''} #${c.id}`.toLowerCase().includes(search.value.toLowerCase())));
const cardLists = computed(() => Object.fromEntries(columns.map(([s]) => [s, visible.value.filter(c => c.status === s)])) as Record<Status, Card[]>);
const editingCard = computed(() => cards.value.find(c => c.id === editingId.value));
const locked = computed(() => busy.value || editing.value || !!drag.value);
function message(e: unknown) { return e instanceof Error ? e.message : String(e); }
function rememberProject() { try { localStorage.setItem('luna.project', selectedPid.value); } catch {} }
async function loadBoard(refreshProjects = false, background = false) {
  const ticket = ++generation;
  controller?.abort(); const request = new AbortController(); controller = request;
  refreshQueued = false;
  if (!background) { loading.value = true; error.value = ''; }
  try {
    if (refreshProjects) {
      const data = await json<{ projects: Project[] }>('/v1/projects', { signal: request.signal });
      if (ticket !== generation || disposed) return;
      if (background && (busy.value || editing.value || drag.value)) { refreshQueued = true; return; }
      history.projects = data.projects;
      let saved = selectedPid.value || (chat.session || chat.project !== null ? String(chat.project ?? data.projects.find(p => p.general)?.id ?? '') : '');
      try { saved ||= localStorage.getItem('luna.project') || ''; } catch {}
      selectedPid.value = data.projects.some(p => String(p.id) === saved) ? saved : String(data.projects[0]?.id ?? '');
      if (selectedPid.value) rememberProject();
    }
    const pid = selectedPid.value, isArchived = archived.value;
    if (!pid) { cards.value = []; return; }
    const data = await json<{ cards: Card[] }>(`/v1/projects/${pid}/board${isArchived ? '?archived=1' : ''}`, { signal: request.signal });
    if (ticket !== generation || disposed) return;
    if (background && (busy.value || editing.value || drag.value)) { refreshQueued = true; return; }
    cards.value = data.cards;
  } catch (e) { if (ticket === generation && !disposed && !request.signal.aborted) error.value = message(e); }
  finally {
    if (ticket === generation && !disposed) {
      loading.value = false;
      if (refreshQueued && !busy.value && !editing.value && !drag.value) void loadBoard(true, true);
    }
  }
}
function changeProject() { cancelDrag(); rememberProject(); cards.value = []; notice.value = ''; void loadBoard(); }
function toggleArchived() { if (locked.value) return; cancelDrag(); archived.value = !archived.value; cards.value = []; notice.value = ''; void loadBoard(); }
function openEditor(c?: Card, status: Status = 'backlog') {
  if (busy.value || loading.value || drag.value) return;
  editorReturn = document.activeElement as HTMLElement | null;
  editingId.value = c?.id ?? null; editingArchived.value = c?.archived ?? false;
  Object.assign(form, { subject: c?.subject || '', description: c?.description || '', priority: c?.priority || 'medium', status: c?.status || status, owner: c?.owner || '', labels: c?.labels.join(', ') || '', blockedBy: c?.blockedBy.map(id => '#' + id).join(', ') || '' });
  answer.value = ''; activity.value = [];
  if (c) void json<{ activity: typeof activity.value }>(`/v1/projects/${selectedPid.value}/cards/${c.id}/activity`).then(d => { if (editingId.value === c.id) activity.value = d.activity; }).catch(() => {});
  error.value = ''; editing.value = true; ui.boardEditing = true;
  void nextTick(() => editorTitle.value?.focus());
}
function closeEditor() {
  if (busy.value) return;
  editing.value = false; ui.boardEditing = false; error.value = '';
  void loadBoard();
  void nextTick(() => { if (editorReturn?.isConnected) editorReturn.focus(); else board.value?.focus(); });
}
async function mutate(action: () => Promise<unknown>, success: string, close = false) {
  if (busy.value || disposed) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    await action();
    if (disposed) return;
    if (close) { editing.value = false; ui.boardEditing = false; }
    notice.value = success;
    await loadBoard();
    if (close) void nextTick(() => { if (editorReturn?.isConnected) editorReturn.focus(); else board.value?.focus(); });
  } catch (e) { if (!disposed) error.value = message(e); }
  finally { busy.value = false; if (refreshQueued && !editing.value && !disposed) void loadBoard(true, true); }
}
function saveCard() {
  if (!form.subject.trim()) { error.value = 'Enter a card title.'; return; }
  const deps = form.blockedBy.split(',').map(s => s.trim()).filter(Boolean);
  if (deps.some(s => !/^#?[1-9]\d*$/.test(s) || !Number.isSafeInteger(Number(s.replace('#', ''))))) { error.value = 'Dependencies must be positive card IDs, separated by commas.'; return; }
  const data = { subject: form.subject.trim(), description: form.description, status: form.status, priority: form.priority, owner: form.owner.trim() || null, labels: form.labels.split(',').map(s => s.trim()).filter(Boolean), blockedBy: deps.map(s => Number(s.replace('#', ''))) };
  const path = `/v1/projects/${selectedPid.value}/cards${editingId.value === null ? '' : '/' + editingId.value}`;
  void mutate(() => post(path, data, editingId.value === null ? 'POST' : 'PATCH'), 'Card saved.', true);
}
function sendAnswer() {
  if (editingId.value === null || !answer.value.trim()) return;
  const path = `/v1/projects/${selectedPid.value}/cards/${editingId.value}`;
  void mutate(() => post(path, { answer: answer.value.trim() }, 'PATCH'), 'Answer sent.', true);
}
function setArchived() {
  if (editingId.value === null) return;
  const path = `/v1/projects/${selectedPid.value}/cards/${editingId.value}`;
  void mutate(() => post(path, { archived: !editingArchived.value }, 'PATCH'), editingArchived.value ? 'Card restored.' : 'Card archived.', true);
}
function deleteCard() {
  if (editingId.value === null || !confirm(`Permanently delete card #${editingId.value}? This cannot be undone.`)) return;
  const path = `/v1/projects/${selectedPid.value}/cards/${editingId.value}`;
  void mutate(() => json(path, { method: 'DELETE' }), 'Card deleted.', true);
}
function moveCard(c: Card, status: Status) {
  if (busy.value || c.status === status) return;
  const path = `/v1/projects/${selectedPid.value}/cards/${c.id}`;
  void mutate(() => post(path, { status }, 'PATCH'), `Card #${c.id} moved to ${columns.find(([s]) => s === status)?.[1]}.`);
}
function blockers(c: Card) { return c.blockedBy.filter(id => !cards.value.some(other => other.id === id && other.status === 'done')); }

// Pointer events cover mouse, pen, and touch. Only the grip prevents touch scrolling.
const drag = ref<{ card: Card; x: number; y: number; startX: number; startY: number; pointer: number; moved: boolean; target: Status | null } | null>(null);
const feedbackText = computed(() => {
  if (error.value) return error.value;
  if (busy.value) return 'Saving changes…';
  if (loading.value) return 'Loading board…';
  const d = drag.value;
  if (d?.moved) return d.target && d.target !== d.card.status
    ? `Drop #${d.card.id} in ${columns.find(([s]) => s === d.target)?.[1]}`
    : 'Drop on another column to move this card.';
  if (editing.value) return editingId.value === null ? 'New card · Not saved' : `Editing card #${editingId.value}`;
  return notice.value || (archived.value ? 'Open a card to restore it.' : 'Drag between columns · Sorted by priority');
});
let animation = 0;
function dragColumn(x: number, y: number): HTMLElement | null {
  const col = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-column]');
  return col && board.value?.contains(col) ? col : null;
}
function startDrag(event: PointerEvent, card: Card) {
  if (locked.value || loading.value || archived.value || event.button !== 0) return;
  event.preventDefault();
  drag.value = { card, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, pointer: event.pointerId, moved: false, target: null };
  board.value?.setPointerCapture(event.pointerId);
  animation = requestAnimationFrame(scrollDrag);
}
function updateDrag(event: PointerEvent) {
  const d = drag.value; if (!d || d.pointer !== event.pointerId) return;
  d.x = event.clientX; d.y = event.clientY;
  d.moved ||= Math.hypot(d.x - d.startX, d.y - d.startY) > 5;
  d.target = dragColumn(d.x, d.y)?.dataset.column as Status || null;
}
function scrollDrag() {
  const d = drag.value, el = board.value; if (!d || !el) return;
  const r = el.getBoundingClientRect();
  if (d.y >= r.top && d.y <= r.bottom && d.x >= r.left && d.x <= r.right) {
    if (d.x > r.right - 44) el.scrollLeft += 10;
    else if (d.x < r.left + 44) el.scrollLeft -= 10;
    const col = dragColumn(d.x, d.y), list = col?.querySelector<HTMLElement>('.kb-cards');
    if (list) { const lr = list.getBoundingClientRect(); if (d.y > lr.bottom - 40) list.scrollTop += 8; else if (d.y < lr.top + 40) list.scrollTop -= 8; }
    d.target = col?.dataset.column as Status || null;
  }
  animation = requestAnimationFrame(scrollDrag);
}
function cancelDrag() {
  const d = drag.value; drag.value = null; cancelAnimationFrame(animation);
  if (d && board.value?.hasPointerCapture(d.pointer)) board.value.releasePointerCapture(d.pointer);
  if (refreshQueued && !busy.value && !editing.value && !disposed) void loadBoard(true, true);
}
function endDrag(event: PointerEvent) {
  const d = drag.value; if (!d || d.pointer !== event.pointerId) return;
  const target = dragColumn(event.clientX, event.clientY)?.dataset.column as Status | undefined;
  // Keep queued feed reads until the write has completed.
  const queued = refreshQueued; refreshQueued = false; cancelDrag(); refreshQueued = queued;
  if (d.moved && target && d.card.status !== target) moveCard(d.card, target);
  else if (refreshQueued) void loadBoard(true, true);
}
function newCardKey(event: KeyboardEvent) {
  if (event.key.toLowerCase() !== 'n' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.defaultPrevented) return;
  const t = event.target as HTMLElement | null;
  if (t?.closest('input, textarea, select, button, [contenteditable]')) return;
  if (archived.value || editing.value || drag.value || locked.value || loading.value || busy.value || !selectedPid.value) return;
  event.preventDefault(); openEditor();
}
function escapeEditor(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  if (drag.value || editing.value) { event.preventDefault(); event.stopImmediatePropagation(); if (drag.value) cancelDrag(); else closeEditor(); }
}
watch(() => chat.project, project => {
  if (project === null || String(project) === selectedPid.value || !history.projects.some(p => p.id === project)) return;
  selectedPid.value = String(project); changeProject();
});
watch(boardChanged, () => {
  if (loading.value || busy.value || editing.value || drag.value) refreshQueued = true;
  else void loadBoard(true, true);
});
onMounted(() => { document.addEventListener('keydown', escapeEditor, true); document.addEventListener('keydown', newCardKey); void loadBoard(true); });
onUnmounted(() => { disposed = true; generation++; controller?.abort(); cancelDrag(); ui.boardEditing = false; document.removeEventListener('keydown', escapeEditor, true); document.removeEventListener('keydown', newCardKey); });
</script>

<template>
  <section class="kb" :class="{ 'kb-editing': editing }" aria-label="Project Kanban">
    <div class="kb-toolbar">
      <label class="kb-project"><span class="kb-sr">Project</span><select v-model="selectedPid" aria-label="Project" :disabled="locked || loading" @change="changeProject"><option v-for="p in history.projects" :key="p.id" :value="String(p.id)">{{ p.name }}</option></select></label>
      <div v-if="selectedPid" class="kb-filters">
        <label class="kb-search"><Search :size="15" /><input v-model="search" aria-label="Search cards" placeholder="Search cards…" /></label>
        <select v-model="priority" aria-label="Filter priority"><option value="">All priorities</option><option v-for="p in priorities" :key="p" :value="p">{{ p }}</option></select>
      </div>
      <div class="kb-toolbar-end">
        <button class="kb-button" :disabled="locked || loading || !selectedPid" @click="toggleArchived"><ArrowLeft v-if="archived" :size="15" /><Archive v-else :size="15" />{{ archived ? 'Back to board' : 'Archived' }}</button>
        <button class="kb-icon" aria-label="Refresh board" title="Refresh board" :disabled="locked || loading" @click="loadBoard(true)"><RefreshCw :size="16" /></button>
        <button v-if="!archived" class="kb-button kb-primary" :disabled="locked || loading || !selectedPid" title="New card (N)" @click="openEditor()"><Plus :size="15" />New card</button>
      </div>
    </div>
    <div v-if="!loading && !history.projects.length && !error" class="kb-empty"><p>Create a project to use its board.</p><button class="kb-button" @click="openPanel('projects')">Open projects</button></div>
    <div v-else-if="selectedPid" class="kb-workspace">
      <div :inert="editing" class="kb-content">
        <div v-if="archived" class="kb-archive">
          <p v-if="!visible.length && !loading" class="kb-empty">{{ cards.length ? 'No cards match these filters.' : 'No archived cards.' }}</p>
          <button v-for="c in visible" :key="c.id" class="kb-archive-card" :data-card="c.id" :disabled="busy || loading" @click="openEditor(c)"><span>#{{ c.id }}</span><strong>{{ c.subject }}</strong><span class="kb-priority" :class="c.priority">{{ c.priority }}</span><span>{{ c.status.replace('_', ' ') }}</span></button>
        </div>
        <div v-else ref="board" class="kb-board" aria-label="Kanban columns" tabindex="0" :aria-busy="busy || loading" @pointermove="updateDrag" @pointerup="endDrag" @pointercancel="cancelDrag" @lostpointercapture="cancelDrag">
          <section v-for="[status, title] in columns" :key="status" class="kb-column" :class="{ 'kb-drop': drag?.moved && drag.target === status && drag.card.status !== status }" :data-column="status" :aria-label="title">
            <h3 class="kb-column-title"><span class="kb-dot" :class="status"></span>{{ title }}<span class="kb-count">{{ cardLists[status].length }}</span></h3>
            <div class="kb-cards">
              <article v-for="c in cardLists[status]" :key="c.id" class="kb-card" :class="{ 'kb-drag-source': drag?.moved && drag.card.id === c.id }" :data-card="c.id" :data-priority="c.priority" :data-status="c.status">
                <div class="kb-card-body">
                  <div class="kb-card-top" @pointerdown="startDrag($event, c)">
                    <span class="kb-card-id">#{{ c.id }}</span>
                    <span class="kb-priority" :class="c.priority"><ChevronsUp v-if="c.priority === 'urgent'" :size="12" /><ArrowUp v-else-if="c.priority === 'high'" :size="12" /><ArrowDown v-else-if="c.priority === 'low'" :size="12" /><Minus v-else :size="12" />{{ c.priority }}</span>
                    <button class="kb-grip" :aria-label="`Drag card #${c.id}`" :disabled="busy || loading" title="Drag between columns"><GripVertical :size="16" /></button>
                  </div>
                  <button class="kb-card-title" :disabled="busy || loading" @click="openEditor(c)">{{ c.subject }}</button>
                  <p v-if="c.description" class="kb-description">{{ c.description }}</p>
                  <div v-if="c.labels.length" class="kb-labels"><span v-for="label in c.labels" :key="label" class="kb-tag">{{ label }}</span></div>
                  <p v-if="blockers(c).length" class="kb-blocked"><LockKeyhole :size="13" /><span><strong>Blocked</strong> · waits on {{ blockers(c).map(id => '#' + id).join(', ') }}</span></p>
                  <p v-if="c.blocked" class="kb-blocked kb-asks"><CircleAlert :size="13" /><span><strong>Needs you</strong> · {{ c.blocked }}</span></p>
                  <div class="kb-owner" :class="{ 'kb-unassigned': !c.owner }"><UserRound :size="13" /><span>{{ c.owner || 'Unassigned' }}</span></div>
                </div>
                <div class="kb-card-footer">
                  <span class="kb-state-dot" aria-hidden="true"><Check v-if="c.status === 'done'" :size="12" /></span>
                  <select class="kb-move" :aria-label="`Move card #${c.id}`" :value="c.status" :disabled="busy || loading" @change="moveCard(c, ($event.target as HTMLSelectElement).value as Status)"><option v-for="[st, label] in columns" :key="st" :value="st">{{ label }}</option></select>
                </div>
              </article>
              <p v-if="!cardLists[status].length && !loading" class="kb-column-empty">{{ cards.some(c => c.status === status) ? 'No matches' : 'No cards' }}</p>
            </div>
            <button class="kb-add" :aria-label="`Add card to ${title}`" :disabled="busy || loading" @click="openEditor(undefined, status)"><Plus :size="13" />Add card</button>
          </section>
        </div>
      </div>
      <form v-if="editing" class="kb-editor" aria-label="Card editor" @submit.prevent="saveCard">
        <div class="kb-editor-head"><h3>{{ editingId === null ? 'New card' : 'Card #' + editingId }}</h3><button type="button" class="kb-icon" aria-label="Close card editor" :disabled="busy" @click="closeEditor"><X :size="17" /></button></div>
        <div class="kb-editor-fields">
          <label>Title<input ref="editorTitle" v-model="form.subject" aria-label="Card title" maxlength="200" required :disabled="busy" /></label>
          <label>Description<textarea v-model="form.description" aria-label="Description" rows="4" maxlength="8000" :disabled="busy"></textarea></label>
          <div class="kb-editor-pair"><label>Priority<select v-model="form.priority" aria-label="Priority" :disabled="busy"><option v-for="p in priorities" :key="p" :value="p">{{ p }}</option></select></label><label>Column<select v-model="form.status" aria-label="Column" :disabled="busy"><option v-for="[s, title] in columns" :key="s" :value="s">{{ title }}</option></select></label></div>
          <label>Owner<input v-model="form.owner" aria-label="Owner" maxlength="100" :disabled="busy" /></label>
          <label>Labels<input v-model="form.labels" aria-label="Labels" placeholder="web, runtime" :disabled="busy" /><small>Comma separated. Up to 20 labels, 40 characters each.</small></label>
          <label>Waits on card IDs<input v-model="form.blockedBy" aria-label="Dependencies" placeholder="#12, #18" :disabled="busy" /><small>Comma separated. Dependencies must belong to this project.</small></label>
          <div v-if="editingCard?.blocked" class="kb-answer">
            <p class="kb-blocked kb-asks"><CircleAlert :size="13" /><span><strong>Blocked</strong> · {{ editingCard.blocked }}</span></p>
            <label>Answer<textarea v-model="answer" aria-label="Answer" rows="3" maxlength="2000" :disabled="busy"></textarea><small>{{ editingCard.owner && /^session \d+$/.test(editingCard.owner) ? `Sent to ${editingCard.owner}. The card is unblocked.` : 'This card has no session owner. The card is unblocked, nobody is notified.' }}</small></label>
            <button type="button" class="kb-button" aria-label="Send answer" :disabled="busy || !answer.trim()" @click="sendAnswer">Send answer</button>
          </div>
          <p v-if="editingCard" class="kb-timestamp">Updated {{ new Date(editingCard.updated).toLocaleString() }}</p>
          <ul v-if="activity.length" class="kb-activity" aria-label="Activity"><li v-for="a in activity" :key="a.id"><time>{{ new Date(a.at).toLocaleString() }}</time> <strong>{{ a.by }}</strong> {{ a.text }}</li></ul>
        </div>
        <div class="kb-editor-actions"><button type="submit" class="kb-button kb-primary" :disabled="busy">{{ busy ? 'Saving…' : 'Save card' }}</button><button type="button" class="kb-button" :disabled="busy" @click="closeEditor">Cancel</button><span></span><button v-if="editingId !== null" type="button" class="kb-button" :disabled="busy" @click="setArchived">{{ editingArchived ? 'Restore' : 'Archive' }}</button><button v-if="editingId !== null" type="button" class="kb-button kb-danger" :disabled="busy" @click="deleteCard">Delete</button></div>
      </form>
    </div>
    <footer class="kb-statusbar" :class="{ 'kb-status-error': error, 'kb-status-success': notice && !error && !busy && !loading && !drag?.moved && !editing }" aria-label="Board status">
      <div class="kb-feedback" :role="error ? 'alert' : 'status'" aria-atomic="true">
        <CircleAlert v-if="error" :size="15" /><RefreshCw v-else-if="busy || loading" class="kb-saving-icon" :size="14" /><ArrowRight v-else-if="drag?.moved" :size="14" /><Check v-else-if="notice && !editing" :size="15" />
        <span class="kb-feedback-text">{{ feedbackText }}</span>
        <button v-if="error && !editing && !busy" class="kb-link" @click="loadBoard(true)">Retry</button>
      </div>
      <span v-if="selectedPid" class="kb-status-count">{{ visible.length }}{{ visible.length !== cards.length ? ' / ' + cards.length : '' }} cards</span>
    </footer>
    <Teleport to="body"><div v-if="drag?.moved" class="kb-ghost" :style="{ left: drag.x + 12 + 'px', top: drag.y + 12 + 'px' }" aria-hidden="true"><small>#{{ drag.card.id }}</small><strong>{{ drag.card.subject }}</strong></div></Teleport>
  </section>
</template>

<style scoped>
.kb { height:100%; min-height:0; min-width:0; display:flex; flex-direction:column; padding:18px 20px 20px; gap:14px; font-size:14px; color:var(--foreground); background:var(--background); }
.kb *, .kb-ghost { box-sizing:border-box; }
.kb button, .kb select { cursor:pointer; }
.kb button:disabled, .kb select:disabled { cursor:default; opacity:.45; }
.kb button, .kb input, .kb textarea, .kb select { font:inherit; }
.kb input, .kb textarea, .kb select { color:inherit; border:1px solid var(--input); border-radius:6px; background:var(--card); padding:8px 10px; min-width:0; max-width:100%; }
.kb select { text-overflow:ellipsis; }
.kb-button, .kb-icon { display:inline-flex; align-items:center; justify-content:center; gap:7px; border:1px solid var(--border); background:var(--card); color:inherit; border-radius:6px; padding:7px 11px; min-height:34px; line-height:1.3; }
.kb-button:hover:not(:disabled), .kb-icon:hover:not(:disabled) { border-color:var(--muted-foreground); background:var(--secondary); }
.kb .kb-primary { background:var(--primary); color:var(--primary-foreground); border-color:var(--primary); }
.kb .kb-primary:hover:not(:disabled) { background:var(--acc-strong); }
.kb-icon { width:34px; flex:none; padding:7px; }
.kb-toolbar { display:flex; align-items:center; gap:12px; flex-wrap:wrap; flex:none; }
.kb-project { min-width:0; flex:0 1 190px; max-width:240px; }
.kb-project select { width:100%; }
.kb-filters { display:flex; align-items:center; gap:8px; flex:1; min-width:280px; }
.kb-filters > select { flex:0 1 145px; }
.kb-search { display:flex; align-items:center; gap:8px; border:1px solid var(--border); border-radius:6px; padding-left:10px; flex:1; max-width:340px; min-width:120px; color:var(--muted-foreground); }
.kb-search input { border:0; background:transparent; width:100%; }
.kb-search:focus-within { outline:2px solid var(--ring); outline-offset:2px; }
.kb-search input:focus-visible { outline:none; }
.kb-toolbar-end { margin-left:auto; display:flex; flex-wrap:wrap; gap:8px; }
.kb-statusbar { margin-top:auto; height:36px; min-height:36px; flex:none; display:flex; align-items:center; justify-content:space-between; gap:16px; border-top:1px solid var(--border); font-size:12px; color:var(--muted-foreground); padding:7px 2px 0; }
.kb-feedback { display:flex; align-items:center; gap:8px; margin:0; min-width:0; flex:1; height:100%; }
.kb-feedback > svg { flex:none; }
.kb-feedback-text { min-width:0; white-space:nowrap; overflow:auto; scrollbar-width:thin; }
.kb-status-count { flex:none; font-variant-numeric:tabular-nums; }
.kb-status-error { color:var(--destructive); }
.kb-status-success { color:#8ed8b0; }
.kb-link { text-decoration:underline; flex:none; min-height:28px; }
.kb-saving-icon { animation:kb-spin 1.5s linear infinite; }
@keyframes kb-spin { to { transform:rotate(360deg); } }
@media(prefers-reduced-motion:reduce) { .kb-saving-icon { animation:none; } }
.kb-workspace { flex:1; min-height:0; min-width:0; display:flex; gap:16px; position:relative; }
.kb-content { flex:1; min-width:0; min-height:0; display:flex; }
.kb-board { flex:1; display:flex; gap:14px; overflow-x:auto; overflow-y:hidden; min-height:0; min-width:0; padding:3px 3px 12px; scrollbar-width:thin; overscroll-behavior:contain; }
.kb-column { min-width:210px; flex:1 0 210px; display:flex; flex-direction:column; min-height:0; border-right:1px solid var(--border); padding:0 12px 0 0; border-radius:4px; }
.kb-column:last-child { border-right-color:transparent; }
.kb-column-title { display:flex; align-items:center; gap:8px; padding:8px 2px 14px; margin:0; text-transform:uppercase; font-size:12px; font-weight:650; letter-spacing:.06em; flex:none; }
.kb-dot { width:6px; height:6px; flex:none; background:#8c95a5; border-radius:50%; }
.kb-dot.todo { background:#7398cb; }.kb-dot.in_progress { background:#d6a453; }.kb-dot.review { background:#a08bcc; }.kb-dot.done { background:#6b9e84; }
.kb-count { margin-left:auto; color:var(--muted-foreground); font-variant-numeric:tabular-nums; font-weight:500; padding:2px 6px; background:var(--secondary); border-radius:5px; }
.kb-cards { overflow-y:auto; overflow-x:hidden; scrollbar-width:thin; flex:1; min-height:70px; padding:1px 3px 5px; overscroll-behavior:contain; }
.kb-card { --priority-color:#9caabe; --status-color:#9caabe; display:flex; flex-direction:column; border:1px solid #303842; border-left:3px solid var(--priority-color); border-radius:8px; background:var(--card); margin-bottom:10px; min-width:0; overflow:hidden; overflow-wrap:anywhere; }
.kb-card[data-priority="urgent"] { --priority-color:#f18f98; }
.kb-card[data-priority="high"] { --priority-color:#ebbf77; }
.kb-card[data-priority="medium"] { --priority-color:#8faee0; }
.kb-card[data-priority="low"] { --priority-color:#9da8b5; }
.kb-card[data-status="todo"] { --status-color:#90bafa; }
.kb-card[data-status="in_progress"] { --status-color:#ecc275; }
.kb-card[data-status="review"] { --status-color:#c6a6f7; }
.kb-card[data-status="done"] { --status-color:#8ad1ac; background:color-mix(in srgb,#8ad1ac 3%,var(--card)); }
.kb-card:hover { border-top-color:#566173; border-right-color:#566173; border-bottom-color:#566173; }
.kb-card-body { padding:10px 12px 12px; flex:1; min-width:0; }
.kb-card-top { touch-action:none; user-select:none; cursor:grab; display:flex; align-items:center; gap:7px; min-height:28px; }
.kb-card-id { margin-right:auto; color:#9da9b8; font:12px var(--mono); }
.kb-grip { touch-action:none; user-select:none; cursor:grab!important; display:grid; place-items:center; width:26px; height:28px; flex:none; background:transparent; border:0; border-radius:4px; color:var(--muted-foreground); }
.kb-card-top:hover .kb-grip { color:var(--primary); background:var(--secondary); }
.kb-card-title { display:block; width:100%; text-align:left; font-weight:600!important; font-size:14.5px!important; line-height:1.55; letter-spacing:.005em; padding:7px 0 10px; background:transparent; border:0; overflow-wrap:anywhere; }
.kb-card-title:hover { color:var(--primary); }
.kb-description { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; line-clamp:2; overflow:hidden; color:var(--muted-foreground); font-size:12.5px; font-weight:440; line-height:1.6; margin:0 0 10px; white-space:pre-wrap; }
.kb-priority { display:inline-flex; align-items:center; gap:3px; border-radius:4px; padding:3px 5px; font-size:11px; line-height:1; text-transform:capitalize; color:#b4bfd0; background:#252d38; white-space:nowrap; }
.kb-priority.high { color:#f0c783; background:#352d20; }
.kb-priority.urgent { color:#ffa5ad; background:#3c252c; }
.kb-priority.medium { color:#a8c4f0; background:#243145; }
.kb-priority.low { color:#b2bdca; background:#292f37; }
.kb-priority svg { flex:none; }
.kb-labels { display:flex; align-items:center; gap:5px; flex-wrap:wrap; margin:0 0 12px; }
.kb-tag { border:1px solid #333d49; background:#1b222b; padding:2px 6px; border-radius:4px; color:#b3becc; font-size:11px; line-height:1.4; max-width:100%; overflow-wrap:anywhere; }
.kb-owner { display:flex; align-items:flex-start; gap:6px; font-size:12px; color:#bec8d5; overflow-wrap:anywhere; }
.kb-owner svg { flex:none; margin-top:2px; }
.kb-owner span { min-width:0; }
.kb-unassigned { color:var(--muted-foreground); }
.kb-blocked { display:flex; align-items:flex-start; gap:6px; color:#efcb8c; background:#322b1f; border:1px solid #51412a; padding:7px; border-radius:5px; font-size:11px; line-height:1.5; margin:0 0 12px; }
.kb-blocked strong { font-weight:600; }
.kb-blocked svg { flex:none; margin-top:1px; }
.kb-card-footer { display:flex; align-items:center; gap:7px; border-top:1px solid #2b343e; background:color-mix(in srgb,var(--status-color) 5%,var(--background)); padding:4px 9px; margin-top:auto; }
.kb-state-dot { width:12px; height:12px; flex:none; display:grid; place-items:center; color:var(--status-color); }
.kb-state-dot:empty::after { content:''; width:6px; height:6px; background:currentColor; border-radius:50%; }
.kb .kb-move { width:100%; min-width:0; font-size:12px; color:var(--status-color); border:1px solid transparent; padding:5px 0; background:transparent; border-radius:4px; }
.kb .kb-move:hover:not(:disabled) { background:var(--secondary); }
.kb-add { display:flex; gap:6px; align-items:center; border:1px dashed var(--border); border-radius:5px; padding:8px 10px; margin:10px 3px 0; color:var(--muted-foreground); text-align:left; background:transparent; font-size:12px!important; flex:none; }
.kb-add:hover { color:var(--primary); border-color:var(--primary); }
.kb-column-empty { color:var(--faint); font-size:12px; padding:10px 2px; }
.kb-drop { background:var(--acc-soft); outline:2px solid var(--primary); outline-offset:-2px; }
.kb-drag-source { opacity:.3; }
.kb-ghost { position:fixed; z-index:60; width:200px; padding:12px; border:1px solid var(--primary); border-radius:6px; background:var(--card); color:var(--foreground); pointer-events:none; box-shadow:var(--shadow); overflow-wrap:anywhere; }.kb-ghost small { color:var(--muted-foreground); font:11px var(--mono); display:block; margin-bottom:8px; }.kb-ghost strong { font:550 13.5px/1.5 system-ui,sans-serif; }
.kb-empty { margin:auto; padding:24px; text-align:center; color:var(--muted-foreground); }.kb-empty p { margin-bottom:14px; }
.kb-archive { flex:1; min-width:0; overflow:auto; }.kb-archive-card { display:flex; gap:16px; align-items:center; text-align:left; width:100%; border:1px solid var(--border); border-radius:6px; background:var(--card); padding:12px; margin-bottom:8px; overflow-wrap:anywhere; }.kb-archive-card strong { flex:1; min-width:0; font-weight:500; }.kb-archive-card>span { color:var(--muted-foreground); font-size:12px; }
.kb-editor { display:flex; flex-direction:column; flex:0 0 360px; width:360px; min-width:0; min-height:0; border:1px solid var(--border); border-radius:8px; background:var(--card); }
.kb-editor-head { display:flex; align-items:center; justify-content:space-between; padding:12px 14px; border-bottom:1px solid var(--border); flex:none; }.kb-editor-head h3 { margin:0; font-weight:600; }
.kb-editor-fields { overflow:auto; min-height:0; padding:16px; display:grid; gap:14px; scrollbar-width:thin; }.kb-editor label { display:grid; gap:6px; font-size:13px; min-width:0; }.kb-editor input,.kb-editor textarea,.kb-editor select { width:100%; background:var(--background); }.kb-editor textarea { resize:vertical; min-height:80px; font-size:15px; font-weight:450; line-height:1.55; }.kb-editor small { font-size:11px; color:var(--muted-foreground); line-height:1.5; }.kb-editor-pair { display:grid; grid-template-columns:1fr 1fr; gap:10px; }.kb-timestamp { font-size:11px; color:var(--muted-foreground); }
.kb-editor-actions { display:flex; flex-wrap:wrap; gap:8px; padding:12px; border-top:1px solid var(--border); flex:none; margin-top:auto; }.kb-editor-actions>span { flex:1; }.kb .kb-danger { color:var(--destructive); }
.kb-answer { display:grid; gap:8px; }
.kb-asks { margin:0; }
.kb-activity { list-style:none; margin:0; padding:10px 0 0; border-top:1px solid var(--border); display:grid; gap:6px; font-size:12px; color:var(--muted-foreground); max-height:180px; overflow:auto; }
.kb-activity time { display:block; font-size:11px; color:var(--faint); }
.kb-activity strong { color:var(--foreground); font-weight:550; }
.kb-sr { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
@media(max-width:1000px) { .kb-editor { position:absolute; inset:0 0 0 auto; width:min(420px,100%); z-index:2; box-shadow:var(--shadow); }.kb-content[inert] { opacity:.35; }.kb-project { flex-basis:150px; }.kb-filters { min-width:260px; } }
@media(max-width:760px) {
  .kb-editing .kb-toolbar { display:none; }
  .kb { padding:12px; gap:10px; }
  .kb-editing { padding-top:8px; padding-bottom:8px; gap:6px; }
  .kb-toolbar { gap:8px; }
  .kb-project { flex:1 0 100%; max-width:none; }
  .kb-filters { flex:1 0 100%; min-width:0; }
  .kb-search { max-width:none; min-width:100px; }
  .kb-filters > select { flex:0 1 140px; }
  .kb-toolbar-end { width:100%; margin-left:0; }
  .kb-toolbar-end .kb-primary { margin-left:auto; }
  .kb-column { flex-basis:245px; min-width:245px; }
  .kb-editor { inset:0; width:100%; }
  .kb-editor-actions>span { display:none; }
  .kb-archive-card { flex-wrap:wrap; gap:8px; }
  .kb-grip { height:36px; width:28px; }
  .kb-button,.kb-icon,.kb-add { min-height:38px; }
  .kb-statusbar { height:30px; min-height:30px; gap:8px; font-size:11px; padding-top:4px; }
  .kb-status-count { display:none; }
}
</style>
