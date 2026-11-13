<script lang="ts">
// Retain only successful snapshots across panel remounts; every open revalidates.
const boardSnapshots = new Map<string, unknown[]>();
let boardCacheContext = "";
</script>
<script setup lang="ts">
import { confirmAction } from "@/lib/confirm";
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { Archive, ArrowLeft, GripVertical, Plus, Search, RefreshCw, X, LockKeyhole, ArrowUp, ArrowDown, ChevronsUp, Minus, UserRound, Check, CircleAlert, ArrowRight, Paperclip, Download, Bot } from '@lucide/vue';
import ModelCombobox from '@/components/ModelCombobox.vue';
import { LEVELS } from '@/lib/thinking-levels';
import { api, json, post, serverUrl, token } from '@/lib/api';
import { saveFile } from '@/lib/platform';
import { history, loadProjects, querySessions } from '@/stores/sessions';
import { chat } from '@/stores/chat';
import { boardChanged, openPanel, ui } from '@/stores/app';
import BoardImage from './BoardImage.vue';
import type { Project, SessionMeta } from '@/lib/types';

type Status = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';
type Priority = 'low' | 'medium' | 'high' | 'urgent';
type Card = { id: number; project: number; subject: string; description: string; status: Status; priority: Priority; owner: string | null; blocked: string | null; labels: string[]; blockedBy: number[]; archived: boolean; created: number; updated: number; auto: { model: string | null; thinking: string | null } | null; attachments: { id: number; name: string; type: string; size: number }[] };
const columns: [Status, string][] = [['backlog', 'Backlog'], ['todo', 'To do'], ['in_progress', 'In progress'], ['review', 'Review'], ['done', 'Done']];
const priorities: Priority[] = ['low', 'medium', 'high', 'urgent'];
const cards = ref<Card[]>([]), selectedPid = ref(''), archived = ref(false);
const loading = ref(true), busy = ref(false), error = ref(''), notice = ref('');
const search = ref(''), priority = ref('');
const editing = ref(false), editingId = ref<number | null>(null), editingArchived = ref(false);
type Draft = { subject: string; description: string; priority: Priority; status: Status; owner: string; labels: string[]; blockedBy: number[]; project: string; auto: boolean; autoModel: string; autoThinking: string };
const form = reactive<Draft>({ subject: '', description: '', priority: 'medium', status: 'backlog', owner: '', labels: [], blockedBy: [], project: '', auto: false, autoModel: '', autoThinking: '' });
let initial: Draft = { ...form };
const fieldErrors = reactive({ subject: '', description: '', labels: '', blockedBy: '' });
type Field = keyof typeof fieldErrors;
const ownerTouched = ref(false), discardAsk = ref(false), formBanner = ref(''), subjectFocus = ref(false), pulseLabel = ref('');
const labelDraft = ref(''), labelOpen = ref(false), labelActive = ref(0);
const depQuery = ref(''), depOpen = ref(false), depActive = ref(0);
const editorDialog = ref<HTMLElement>(), labelInput = ref<HTMLInputElement>(), depInput = ref<HTMLInputElement>();
const answer = ref(''), activity = ref<{ id: number; at: number; by: string; text: string }[]>([]);
const board = ref<HTMLElement>(), editorTitle = ref<HTMLInputElement>(), fileInput = ref<HTMLInputElement>();
let generation = 0, disposed = false, controller: AbortController | undefined, refreshQueued = false;
let editorReturn: HTMLElement | null = null;
const searchEntries = computed(() => cards.value.map(card => ({ card, text: `${card.subject} ${card.description} ${card.labels.join(' ')} ${card.owner || ''} #${card.id}`.toLowerCase() })));
const visible = computed(() => {
  const query = search.value.toLowerCase();
  return searchEntries.value.filter(({ card, text }) => (!priority.value || card.priority === priority.value) && text.includes(query)).map(entry => entry.card);
});
const cardLists = computed(() => Object.fromEntries(columns.map(([s]) => [s, visible.value.filter(c => c.status === s)])) as Record<Status, Card[]>);
const editingCard = computed(() => cards.value.find(c => c.id === editingId.value));
const readOnly = computed(() => busy.value || editingArchived.value);
const projectName = computed(() => history.projects.find(p => String(p.id) === selectedPid.value)?.name ?? '');
const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const dirty = computed(() => form.subject !== initial.subject || form.description !== initial.description || form.priority !== initial.priority || form.status !== initial.status
  || form.owner.trim() !== initial.owner || !same(form.labels, initial.labels) || !same([...form.blockedBy].sort(), [...initial.blockedBy].sort()) || form.project !== initial.project || autoChanged() || !!labelDraft.value.trim());
const autoChanged = () => form.auto !== initial.auto || (form.auto && (form.autoModel !== initial.autoModel || form.autoThinking !== initial.autoThinking));
const autoValue = () => form.auto ? { model: form.autoModel || null, thinking: form.autoThinking || null } : null;
const autoText = (a: NonNullable<Card['auto']>) => `${a.model ? a.model.slice(a.model.indexOf('/') + 1) : 'default model'}${a.thinking ? ` · ${a.thinking}` : ''}`;
const autoRunning = (c: Card) => !!c.auto && c.status === 'in_progress' && /^session \d+$/.test(c.owner || '');
const subjectLength = computed(() => form.subject.trim().length);
// Labels in use on this board, most used first.
const labelOptions = computed(() => {
  const counts = new Map<string, number>();
  for (const c of cards.value) for (const l of c.labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  const q = labelDraft.value.trim().toLowerCase(), added = new Set(form.labels.map(l => l.toLowerCase()));
  return [...counts].filter(([l]) => !added.has(l.toLowerCase()) && l.toLowerCase().includes(q)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([l]) => l);
});
const depOptions = computed(() => {
  const q = depQuery.value.trim().toLowerCase().replace(/^#/, '');
  if (!q) return [];
  return cards.value.filter(c => !form.blockedBy.includes(c.id) && (String(c.id).startsWith(q) || c.subject.toLowerCase().includes(q)))
    .sort((a, b) => Number(String(b.id) === q) - Number(String(a.id) === q) || a.id - b.id).slice(0, 8);
});
const ownerSessions = ref<SessionMeta[]>([]), ownersLoading = ref(false), ownersError = ref(''), customOwner = ref(false);
let ownersController: AbortController | undefined;
const ownerOptions = computed(() => [...new Set([initial.owner, form.owner, ...cards.value.map(c => c.owner)])]
  .filter((o): o is string => !!o && o !== 'user' && !ownerSessions.value.some(s => o === `session ${s.id}`)).sort());
const ownerSelection = computed({
  get: () => customOwner.value ? 'custom' : `owner:${form.owner}`,
  set: (value: string) => {
    customOwner.value = value === 'custom';
    if (!customOwner.value) form.owner = value.slice('owner:'.length);
    ownerTouched.value = true;
  },
});
async function loadOwners() {
  ownersController?.abort();
  const request = new AbortController(); ownersController = request;
  ownerSessions.value = []; ownersLoading.value = true; ownersError.value = '';
  try {
    const sessions: SessionMeta[] = [];
    let cursor: string | null = null;
    do {
      const page = await querySessions({ project: Number(form.project), archived: '0', limit: 100, cursor }, request.signal);
      sessions.push(...page.sessions); cursor = page.nextCursor;
    } while (cursor && !request.signal.aborted);
    if (!request.signal.aborted) ownerSessions.value = sessions;
  } catch (e) {
    if (!request.signal.aborted) ownersError.value = message(e);
  } finally {
    if (!request.signal.aborted) ownersLoading.value = false;
  }
}
// The server releases the owner on Done or archive unless the same change sets one.
const ownerHint = computed(() => {
  if (editingId.value === null || form.status !== 'done' || initial.status === 'done') return '';
  if (!ownerTouched.value) return initial.owner ? `${initial.owner} is released when you save (Done).` : '';
  return form.owner.trim() ? `Owner kept: ${form.owner.trim()} (set by hand).` : '';
});
const locked = computed(() => busy.value || editing.value || !!drag.value);
function message(e: unknown) { return e instanceof Error ? e.message : String(e); }
function rememberProject() { try { localStorage.setItem('luna.project', selectedPid.value); } catch {} }

function computeResolvedProjectId(projects: Project[] = history.projects): string {
  let saved = (ui.boardTarget ? String(ui.boardTarget.projectId) : selectedPid.value)
    || (chat.session || chat.project !== null ? String(chat.project ?? projects.find(p => p.general)?.id ?? '') : '');
  try { saved ||= localStorage.getItem('luna.project') || ''; } catch {}
  return projects.some(p => String(p.id) === saved) ? saved : String(projects[0]?.id ?? '');
}

async function loadBoard(refreshProjects = false, background = false) {
  const ticket = ++generation;
  controller?.abort(); const request = new AbortController(); controller = request;
  refreshQueued = false;
  if (!background) { loading.value = true; error.value = ''; }

  let projectsPromise: Promise<{ projects: Project[] }> | undefined;
  if (refreshProjects || !history.projectsLoaded) {
    projectsPromise = loadProjects().then(() => ({ projects: history.projects }));
  }

  try {
    if (!selectedPid.value && history.projects.length) {
      selectedPid.value = computeResolvedProjectId(history.projects);
      if (selectedPid.value) rememberProject();
    }

    let pid = selectedPid.value, isArchived = archived.value;

    if (projectsPromise && !pid) {
      await projectsPromise;
      if (ticket !== generation || disposed) return;
      // The shared project store applies the authenticated result.
      if (!history.projects.length) {
        selectedPid.value = ''; cards.value = []; return;
      }
      pid = computeResolvedProjectId(history.projects);
      selectedPid.value = pid;
      if (pid) rememberProject();
    } else if (projectsPromise) {
      void projectsPromise.then(() => {
        if (ticket !== generation || disposed) return;
        if (busy.value || editing.value || drag.value) { refreshQueued = true; return; }
        // The shared project store applies the authenticated result.
        if (!history.projects.length) {
          generation++; request.abort();
          selectedPid.value = ''; cards.value = []; loading.value = false; return;
        }
        const resolved = computeResolvedProjectId(history.projects);
        const currentValid = history.projects.some(p => String(p.id) === selectedPid.value);
        if (!currentValid || (resolved && resolved !== selectedPid.value && !selectedPid.value)) {
          if (busy.value || editing.value || !!drag.value) {
            refreshQueued = true;
          } else {
            cards.value = [];
            selectedPid.value = resolved;
            rememberProject();
            void loadBoard(false, background);
          }
        }
      }).catch(e => {
        if (ticket === generation && !disposed && !request.signal.aborted) {
          error.value = message(e);
        }
      });
    }

    if (!pid) { cards.value = []; return; }
    const context = JSON.stringify([serverUrl.value, token.value]);
    if (boardCacheContext !== context) { boardSnapshots.clear(); boardCacheContext = context; }
    const cacheKey = JSON.stringify([pid, isArchived]);
    if (!cards.value.length && boardSnapshots.has(cacheKey)) cards.value = boardSnapshots.get(cacheKey)! as Card[];
    const data = await json<{ cards: Card[] }>(`/v1/projects/${pid}/board${isArchived ? '?archived=1' : ''}`, { signal: request.signal });
    if (ticket !== generation || disposed) return;
    if (background && (busy.value || editing.value || drag.value)) { refreshQueued = true; return; }
    cards.value = data.cards;
    boardSnapshots.delete(cacheKey); boardSnapshots.set(cacheKey, data.cards);
    if (boardSnapshots.size > 12) boardSnapshots.delete(boardSnapshots.keys().next().value!);
    const target = ui.boardTarget;
    if (target && String(target.projectId) === pid) {
      let found = cards.value.find(card => card.id === target.cardId);
      if (!found) {
        const opposite = await json<{ cards: Card[] }>(`/v1/projects/${pid}/board${isArchived ? '' : '?archived=1'}`, { signal: request.signal });
        if (ticket !== generation || disposed || ui.boardTarget !== target) return;
        found = opposite.cards.find(card => card.id === target.cardId);
        if (found) { archived.value = !isArchived; cards.value = opposite.cards; }
      }
      if (ticket !== generation || disposed || ui.boardTarget !== target) return;
      loading.value = false;
      if (found) { openEditor(found); notice.value = ''; }
      else notice.value = `Card #${target.cardId} no longer exists`;
      ui.boardTarget = null;
    }
  } catch (e) {
    if (ticket === generation && !disposed && !request.signal.aborted) error.value = message(e);
  } finally {
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
  Object.assign(form, { subject: c?.subject || '', description: c?.description || '', priority: c?.priority || 'medium', status: c?.status || status, owner: c?.owner || '', labels: [...(c?.labels ?? [])], blockedBy: [...(c?.blockedBy ?? [])], project: String(c?.project ?? selectedPid.value), auto: !!c?.auto, autoModel: c?.auto?.model || '', autoThinking: c?.auto?.thinking || '' });
  initial = { ...form, labels: [...form.labels], blockedBy: [...form.blockedBy] };
  Object.assign(fieldErrors, { subject: '', description: '', labels: '', blockedBy: '' });
  ownerTouched.value = false; customOwner.value = false; void loadOwners(); discardAsk.value = false; formBanner.value = ''; labelDraft.value = ''; depQuery.value = ''; labelOpen.value = false; depOpen.value = false;
  answer.value = ''; activity.value = [];
  if (c) void json<{ activity: typeof activity.value }>(`/v1/projects/${selectedPid.value}/cards/${c.id}/activity`).then(d => { if (editingId.value === c.id) activity.value = d.activity; }).catch(() => {});
  error.value = ''; editing.value = true; ui.boardEditing = true;
  void nextTick(() => editorTitle.value?.focus());
}
function closeEditor(force = false) {
  if (busy.value) return;
  if (!force && dirty.value && !editingArchived.value) { discardAsk.value = true; void nextTick(() => editorDialog.value?.querySelector<HTMLElement>('.kb-discard .kb-primary')?.focus()); return; }
  discardAsk.value = false; editing.value = false; ui.boardEditing = false; error.value = '';
  // Refresh disables the trigger. Restore focus only after it becomes usable again.
  void loadBoard().then(() => nextTick(() => {
    if (disposed || editing.value) return;
    if (editorReturn?.isConnected) editorReturn.focus(); else board.value?.focus();
  }));
}
async function mutate(action: () => Promise<unknown>, success: string, close = false, settle?: () => void) {
  if (busy.value || disposed) return;
  const scope = JSON.stringify([serverUrl.value, token.value]);
  const current = () => !disposed && scope === JSON.stringify([serverUrl.value, token.value]);
  busy.value = true; error.value = ''; notice.value = '';
  boardSnapshots.clear();
  try {
    await action();
    if (!current()) return;
    if (close) { editing.value = false; ui.boardEditing = false; }
    notice.value = success;
    if (settle) { settle(); rememberProject(); }
    await loadBoard(false);
    if (close) void nextTick(() => { if (editorReturn?.isConnected) editorReturn.focus(); else board.value?.focus(); });
  } catch (e) { if (current()) error.value = message(e); }
  finally { if (current()) { busy.value = false; if (refreshQueued && !editing.value) void loadBoard(true, true); } }
}
function validate(field: Field) {
  const n = subjectLength.value;
  if (field === 'subject') fieldErrors.subject = !n ? 'Subject is required.' : n > 200 ? `Subject must be 1-200 characters after trimming (currently ${n}).` : '';
  if (field === 'description') fieldErrors.description = form.description.length > 8000 ? `Description is limited to 8,000 characters (currently ${form.description.length.toLocaleString()}).` : '';
  return !fieldErrors[field];
}
function trimSubject() { form.subject = form.subject.trim(); subjectFocus.value = false; validate('subject'); }
function focusField(field: Field) {
  const el = editorDialog.value?.querySelector<HTMLElement>(`[data-field="${field}"]`);
  el?.focus(); el?.scrollIntoView({ block: 'nearest' });
}
function fieldOf(text: string): Field | undefined {
  return /subject/i.test(text) ? 'subject' : /description/i.test(text) ? 'description' : /label/i.test(text) ? 'labels' : /blockedBy|cycle|dependenc/i.test(text) ? 'blockedBy' : undefined;
}
async function saveCard() {
  if (busy.value || editingArchived.value) return;
  if (labelDraft.value.trim()) commitLabels(labelDraft.value);
  form.subject = form.subject.trim();
  const bad = (['subject', 'description'] as Field[]).filter(f => !validate(f)).concat((['labels', 'blockedBy'] as Field[]).filter(f => fieldErrors[f]));
  if (bad.length) { formBanner.value = bad.length === 1 ? 'Fix 1 error to continue.' : `Fix ${bad.length} errors to continue.`; focusField(bad[0]!); return; }
  formBanner.value = '';
  const target = editingId.value !== null && form.project !== selectedPid.value ? Number(form.project) : undefined;
  if (target !== undefined && !history.projects.some(p => p.id === target)) { formBanner.value = 'Select a project.'; return; }
  let data: Record<string, unknown>;
  if (editingId.value === null) {
    data = { subject: form.subject, description: form.description, status: form.status, priority: form.priority, labels: form.labels, blockedBy: form.blockedBy };
    if (form.owner.trim()) data.owner = form.owner.trim();
    if (form.auto) data.auto = autoValue();
  } else {
    // Send only what changed. An omitted owner lets the server release it on Done.
    data = {};
    for (const k of ['subject', 'description', 'status', 'priority'] as const) if (form[k] !== initial[k]) data[k] = form[k];
    if (!same(form.labels, initial.labels)) data.labels = form.labels;
    if (ownerTouched.value) data.owner = form.owner.trim() || null;
    if (autoChanged()) data.auto = autoValue();
    const add = form.blockedBy.filter(id => !initial.blockedBy.includes(id)), remove = initial.blockedBy.filter(id => !form.blockedBy.includes(id));
    if (add.length) data.addBlockedBy = add;
    if (remove.length) data.removeBlockedBy = remove;
    if (target !== undefined) data.project = target;
    if (!Object.keys(data).length) { closeEditor(true); notice.value = 'No changes.'; return; }
  }
  const path = `/v1/projects/${selectedPid.value}/cards${editingId.value === null ? '' : '/' + editingId.value}`;
  const created = editingId.value === null;
  await mutate(() => post(path, data, created ? 'POST' : 'PATCH'), target === undefined ? (created ? 'Card created.' : `Card #${editingId.value} updated.`) : `Card #${editingId.value} moved to ${history.projects.find(p => p.id === target)?.name ?? 'another project'}.`, true, target === undefined ? undefined : () => { selectedPid.value = String(target); cards.value = []; });
  // A rejected save keeps the dialog open: put the server message on its field.
  if (editing.value && error.value) {
    const field = fieldOf(error.value);
    formBanner.value = error.value; error.value = '';
    if (field) { fieldErrors[field] = formBanner.value; void nextTick(() => focusField(field)); }
  }
}
function commitLabels(text: string) {
  fieldErrors.labels = '';
  for (const raw of text.split(',')) {
    const l = raw.trim(); if (!l) continue;
    const dup = form.labels.find(x => x.toLowerCase() === l.toLowerCase());
    if (dup) { pulseLabel.value = ''; void nextTick(() => { pulseLabel.value = dup; }); continue; }
    if (l.length > 40) { fieldErrors.labels = `Labels are limited to 40 characters ("${l.slice(0, 20)}…" has ${l.length}).`; continue; }
    if (form.labels.length >= 20) { fieldErrors.labels = 'A card can have up to 20 labels.'; break; }
    form.labels.push(l);
  }
  labelDraft.value = ''; labelActive.value = 0;
}
function labelKey(event: KeyboardEvent) {
  const open = labelOpen.value && labelOptions.value.length > 0;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { if (!labelOptions.value.length) return; event.preventDefault(); labelOpen.value = true; labelActive.value = (labelActive.value + (event.key === 'ArrowDown' ? 1 : -1) + labelOptions.value.length) % labelOptions.value.length; }
  else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); commitLabels(open && labelActive.value >= 0 && labelDraft.value.trim() ? labelOptions.value[labelActive.value]! : labelDraft.value); }
  else if (event.key === ',') { event.preventDefault(); commitLabels(labelDraft.value); }
  else if (event.key === 'Backspace' && !labelDraft.value && form.labels.length) { form.labels.pop(); fieldErrors.labels = ''; }
  else if (event.key === 'Escape' && open) { event.preventDefault(); labelOpen.value = false; }
}
function labelPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text') ?? '';
  if (!text.includes(',')) return;
  event.preventDefault(); commitLabels(labelDraft.value + text);
}
function removeLabel(l: string) { form.labels = form.labels.filter(x => x !== l); fieldErrors.labels = ''; labelInput.value?.focus(); }
/** Path that closes a loop if this card starts to wait on `dep`, or null. */
function cyclePath(dep: number): number[] | null {
  const self = editingId.value; if (self === null) return null;
  const edges = new Map(cards.value.map(c => [c.id, c.blockedBy]));
  const parent = new Map<number, number | null>([[dep, null]]), stack = [dep];
  while (stack.length) {
    const id = stack.pop()!;
    for (const next of edges.get(id) ?? []) {
      if (next === self) { const path = [id]; for (let at = parent.get(id); at != null; at = parent.get(at)) path.unshift(at); return [self, ...path, self]; }
      if (!parent.has(next)) { parent.set(next, id); stack.push(next); }
    }
  }
  return null;
}
function addDep(c: Card) {
  if (c.id === editingId.value) return;
  const loop = cyclePath(c.id);
  if (loop) { fieldErrors.blockedBy = `Circular dependency: ${loop.map(id => '#' + id).join(' → ')}. This dependency can't be added.`; return; }
  fieldErrors.blockedBy = ''; form.blockedBy.push(c.id); depQuery.value = ''; depActive.value = 0; depOpen.value = false;
}
function removeDep(id: number) { form.blockedBy = form.blockedBy.filter(d => d !== id); fieldErrors.blockedBy = ''; depInput.value?.focus(); }
function depKey(event: KeyboardEvent) {
  const list = depOptions.value;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { if (!list.length) return; event.preventDefault(); depOpen.value = true; depActive.value = (depActive.value + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length; }
  else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); const c = list[depActive.value]; if (depOpen.value && c) addDep(c); }
  else if (event.key === 'Backspace' && !depQuery.value && form.blockedBy.length) { form.blockedBy.pop(); fieldErrors.blockedBy = ''; }
  else if (event.key === 'Escape' && depOpen.value) { event.preventDefault(); depOpen.value = false; }
}
const revealList = (el: unknown) => { if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' }); };
const depLabel = (id: number) => cards.value.find(c => c.id === id)?.subject ?? '';
function trapFocus(event: KeyboardEvent) {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void saveCard(); return; }
  if (event.key !== 'Tab' || !editorDialog.value) return;
  const items = [...editorDialog.value.querySelectorAll<HTMLElement>('button, input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter(el => !(el as HTMLButtonElement).disabled && el.offsetParent !== null && !el.hidden);
  const first = items[0], last = items[items.length - 1];
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
function moveDraft() {
  if (form.project === selectedPid.value) return;
  form.blockedBy = []; fieldErrors.blockedBy = '';
  if (/^session \d+$/.test(form.owner.trim())) { form.owner = ''; ownerTouched.value = true; }
}
function sendAnswer() {
  if (editingId.value === null || !answer.value.trim()) return;
  const path = `/v1/projects/${selectedPid.value}/cards/${editingId.value}`;
  void mutate(() => post(path, { answer: answer.value.trim() }, 'PATCH'), 'Answer sent.', true);
}
function sizeText(n: number) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
function attachPath(id: number, aid?: number) { return `/v1/projects/${selectedPid.value}/cards/${id}/attachments${aid === undefined ? '' : '/' + aid}`; }
async function refreshEditing() {
  const id = editingId.value; if (id === null) return;
  const data = await json<{ cards: Card[] }>(`/v1/projects/${selectedPid.value}/board${archived.value ? '?archived=1' : ''}`);
  if (!disposed) cards.value = data.cards;
}
function chooseFiles(c?: Card) {
  if (busy.value || loading.value || drag.value) return;
  if (c) openEditor(c);
  void nextTick(() => fileInput.value?.click());
}
async function attachFiles(event: Event) {
  const input = event.target as HTMLInputElement, id = editingId.value;
  const files = [...(input.files ?? [])]; input.value = '';
  if (id === null || !files.length || busy.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    for (const f of files) {
      const r = await api(attachPath(id) + '?name=' + encodeURIComponent(f.name), { method: 'POST', headers: { 'content-type': f.type || 'application/octet-stream' }, body: f });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    }
    await refreshEditing(); notice.value = 'File attached.';
  } catch (e) { if (!disposed) { error.value = message(e); void refreshEditing().catch(() => {}); } }
  finally { busy.value = false; }
}
async function downloadFile(id: number, a: { id: number; name: string }) {
  try {
    const r = await api(attachPath(id, a.id));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    await saveFile(await r.blob(), a.name);
  } catch (e) { error.value = message(e); }
}
async function removeFile(id: number, a: { id: number; name: string }) {
  if (busy.value || !(await confirmAction({ title: `Remove ${a.name}?`, confirmLabel: 'Remove', danger: true }))) return;
  busy.value = true; error.value = ''; notice.value = '';
  try { await json(attachPath(id, a.id), { method: 'DELETE' }); await refreshEditing(); notice.value = 'Attachment removed.'; }
  catch (e) { if (!disposed) error.value = message(e); }
  finally { busy.value = false; }
}
async function setArchived() {
  if (editingId.value === null) return;
  if (!editingArchived.value) {
    const owner = initial.owner && !ownerTouched.value ? `${initial.owner} is released and the` : 'The';
    if (!(await confirmAction({ title: `Archive card #${editingId.value}?`, message: `${owner} card leaves the board.`, confirmLabel: 'Archive' }))) return;
  }
  const path = `/v1/projects/${selectedPid.value}/cards/${editingId.value}`;
  void mutate(() => post(path, { archived: !editingArchived.value }, 'PATCH'), editingArchived.value ? 'Card restored.' : 'Card archived.', true);
}
async function deleteCard() {
  if (editingId.value === null || !(await confirmAction({ title: `Delete card #${editingId.value}?`, message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
  const path = `/v1/projects/${selectedPid.value}/cards/${editingId.value}`;
  void mutate(() => json(path, { method: 'DELETE' }), 'Card deleted.', true);
}
async function moveCard(c: Card, status: Status) {
  if (busy.value || loading.value || c.status === status) return;
  const pid = selectedPid.value, before = c.status;
  const context = JSON.stringify([serverUrl.value, token.value]);
  const path = `/v1/projects/${pid}/cards/${c.id}`;
  const keyboardFocus = document.activeElement?.matches('.kb-move');
  const current = () => !disposed && pid === selectedPid.value && context === JSON.stringify([serverUrl.value, token.value]);
  const apply = (value: Status) => { cards.value = cards.value.map(card => card.id === c.id ? { ...card, status: value } : card); };
  const restoreFocus = () => nextTick(() => {
    if (keyboardFocus && current() && document.activeElement === document.body) board.value?.querySelector<HTMLElement>(`[data-card="${c.id}"] .kb-move`)?.focus();
  });
  busy.value = true; error.value = ''; notice.value = '';
  // Fence a pre-write background read before publishing the optimistic position.
  generation++; controller?.abort();
  apply(status); void restoreFocus();
  boardSnapshots.delete(JSON.stringify([pid, archived.value]));
  try {
    const saved = await post<Card>(path, { status }, 'PATCH');
    if (!current()) return;
    cards.value = cards.value.map(card => card.id === c.id ? saved : card);
    notice.value = `Card #${c.id} moved to ${columns.find(([s]) => s === status)?.[1]}.`;
  } catch (e) {
    if (current()) { apply(before); error.value = message(e); }
  } finally {
    if (current()) {
      busy.value = false; void restoreFocus();
      if (refreshQueued) void loadBoard(false, true);
    }
  }
}

function blockers(c: Card) { return c.blockedBy.filter(id => !cards.value.some(other => other.id === id && other.status === 'done')); }

// Pointer events cover mouse, pen, and touch. Only the grip prevents touch scrolling.
const drag = ref<{ card: Card; x: number; y: number; startX: number; startY: number; pointer: number; moved: boolean; target: Status | null } | null>(null);
const feedbackText = computed(() => {
  if (error.value) return error.value;
  if (busy.value) return 'Saving changes…';
  if (loading.value) return cards.value.length ? 'Updating board…' : 'Loading board…';
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
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
  // Nested dialogs, popovers, and native select menus own Escape first.
  if (document.querySelector('[data-dismissable-layer][data-state="open"], :popover-open') || (event.target as HTMLElement | null)?.closest('select, [aria-expanded="true"]')) return;
  if (drag.value || editing.value) { event.preventDefault(); event.stopImmediatePropagation(); if (drag.value) cancelDrag(); else if (discardAsk.value) { discardAsk.value = false; editorTitle.value?.focus(); } else closeEditor(); }
}
watch(() => form.project, () => { if (editing.value) void loadOwners(); }, { flush: 'sync' });
watch(editing, open => { if (!open) ownersController?.abort(); });
watch([serverUrl, token], () => {
  ownersController?.abort(); ownerSessions.value = [];
  generation++; controller?.abort(); boardSnapshots.clear(); boardCacheContext = '';
  cards.value = []; selectedPid.value = ''; editing.value = false; ui.boardEditing = false; busy.value = false;
  void loadBoard(true);
}, { flush: 'sync' });
watch(() => chat.project, project => {
  if (project === null || String(project) === selectedPid.value || !history.projects.some(p => p.id === project)) return;
  selectedPid.value = String(project); changeProject();
});
watch(() => ui.boardTarget, target => {
  if (!target) return;
  if (editing.value) closeEditor(true);
  selectedPid.value = String(target.projectId);
  void loadBoard(false);
});
watch(boardChanged, () => {
  if (loading.value || busy.value || editing.value || drag.value) refreshQueued = true;
  else void loadBoard(false, true);
});
onMounted(() => {
  document.addEventListener('keydown', escapeEditor, true);
  document.addEventListener('keydown', newCardKey);
  // Deep links can name a project that is not in the sidebar's cached list yet.
  if (ui.boardTarget) selectedPid.value = String(ui.boardTarget.projectId);
  else if (history.projects.length) selectedPid.value = computeResolvedProjectId(history.projects);
  if (selectedPid.value) rememberProject();
  void loadBoard(true);
});
onUnmounted(() => { disposed = true; generation++; controller?.abort(); ownersController?.abort(); cancelDrag(); ui.boardEditing = false; document.removeEventListener('keydown', escapeEditor, true); document.removeEventListener('keydown', newCardKey); });
</script>

<template>
  <section class="kb" :class="{ 'kb-editing': editing }" aria-label="Project Kanban">
    <div class="kb-toolbar" :inert="editing">
      <label class="kb-project"><span class="kb-sr">Project</span><select v-model="selectedPid" aria-label="Project" :disabled="locked" @change="changeProject"><option v-for="p in history.projects" :key="p.id" :value="String(p.id)">{{ p.name }}</option></select></label>
      <div v-if="selectedPid" class="kb-filters">
        <label class="kb-search"><Search :size="15" /><input dir="auto" v-model="search" aria-label="Search cards" placeholder="Search cards…" /></label>
        <select v-model="priority" aria-label="Filter priority"><option value="">All priorities</option><option v-for="p in priorities" :key="p" :value="p">{{ p }}</option></select>
      </div>
      <div class="kb-toolbar-end">
        <button class="kb-button" :disabled="locked || loading || !selectedPid" :title="!selectedPid ? 'Select a project first' : archived ? 'Return to active board' : 'View archived cards'" @click="toggleArchived"><ArrowLeft v-if="archived" :size="15" /><Archive v-else :size="15" />{{ archived ? 'Back to board' : 'Archived' }}</button>
        <button class="kb-icon" aria-label="Refresh board" title="Refresh board" :disabled="locked || loading" @click="loadProjects({ force: true }).then(() => loadBoard(false)).catch(e => error = message(e))"><RefreshCw :size="16" /></button>
        <button v-if="!archived" class="kb-button kb-primary" :disabled="locked || loading || !selectedPid" :title="!selectedPid ? 'Select a project first' : 'New card (N)'" @click="openEditor()"><Plus :size="15" />New card</button>
      </div>
    </div>
    <div v-if="!loading && !history.projects.length && !error" class="kb-empty"><p>Create a project to use its board.</p><button class="kb-button" @click="openPanel('projects')">Open projects</button></div>
    <div v-else-if="selectedPid" class="kb-workspace">
      <div :inert="editing" class="kb-content">
        <div v-if="archived" class="kb-archive">
          <p v-if="!visible.length && !loading" class="kb-empty">{{ cards.length ? 'No cards match these filters.' : 'No archived cards.' }}</p>
          <button v-for="c in visible" :key="c.id" class="kb-archive-card vl vl-sm" :data-card="c.id" :disabled="busy || loading" @click="openEditor(c)"><span>#{{ c.id }}</span><strong dir="auto">{{ c.subject }}</strong><span class="kb-priority" :class="c.priority">{{ c.priority }}</span><span>{{ c.status.replace('_', ' ') }}</span></button>
        </div>
        <div v-else ref="board" class="kb-board" aria-label="Kanban columns" tabindex="0" :aria-busy="busy || loading" @pointermove="updateDrag" @pointerup="endDrag" @pointercancel="cancelDrag" @lostpointercapture="cancelDrag">
          <section v-for="[status, title] in columns" :key="status" class="kb-column" :class="{ 'kb-drop': drag?.moved && drag.target === status && drag.card.status !== status }" :data-column="status" :aria-label="title">
            <h3 class="kb-column-title"><span class="kb-dot" :class="status"></span>{{ title }}<span class="kb-count">{{ cardLists[status].length }}</span></h3>
            <div class="kb-cards">
              <article v-for="c in cardLists[status]" :key="c.id" class="kb-card vl vl-lg" :class="{ 'kb-drag-source': drag?.moved && drag.card.id === c.id }" :data-card="c.id" :data-priority="c.priority" :data-status="c.status">
                <div class="kb-card-body">
                  <div class="kb-card-top" @pointerdown="startDrag($event, c)">
                    <span class="kb-card-id">#{{ c.id }}</span>
                    <span class="kb-priority" :class="c.priority"><ChevronsUp v-if="c.priority === 'urgent'" :size="12" /><ArrowUp v-else-if="c.priority === 'high'" :size="12" /><ArrowDown v-else-if="c.priority === 'low'" :size="12" /><Minus v-else :size="12" />{{ c.priority }}</span>
                    <span class="kb-grip" aria-hidden="true" title="Drag between columns; use the status selector with a keyboard"><GripVertical :size="16" /></span>
                  </div>
                  <div class="kb-card-heading">
                    <button dir="auto" class="kb-card-title" :disabled="busy || loading" :title="busy || loading ? 'Board is updating…' : undefined" @click="openEditor(c)">{{ c.subject }}</button>
                    <button type="button" class="kb-icon kb-card-attach" :aria-label="`Attach files to card #${c.id}`" :title="busy || loading ? 'Board is updating…' : c.attachments.length ? `${c.attachments.length} attachments · Add files` : 'Attach files'" :disabled="busy || loading" @click="chooseFiles(c)"><Paperclip :size="14" /><span v-if="c.attachments.length">{{ c.attachments.length }}</span></button>
                  </div>
                  <p dir="auto" v-if="c.description" class="kb-description">{{ c.description }}</p>
                  <div v-if="c.labels.length" class="kb-labels"><span dir="auto" v-for="label in c.labels" :key="label" class="kb-tag">{{ label }}</span></div>
                  <p v-if="blockers(c).length" class="kb-blocked"><LockKeyhole :size="13" /><span><strong>Blocked</strong> · waits on {{ blockers(c).map(id => '#' + id).join(', ') }}</span></p>
                  <p v-if="c.blocked" class="kb-blocked kb-asks"><CircleAlert :size="13" /><span><strong>Needs you</strong> · <bdi>{{ c.blocked }}</bdi></span></p>
                  <p v-if="c.auto" class="kb-auto" :title="autoRunning(c) ? 'Automatic run in progress' : 'Runs automatically from To do'"><Bot :size="13" /><span><strong>{{ autoRunning(c) ? 'Auto running' : 'Auto' }}</strong> · {{ autoText(c.auto) }}</span></p>
                  <div class="kb-owner" :class="{ 'kb-unassigned': !c.owner }"><UserRound :size="13" /><span dir="auto">{{ c.owner || 'Unassigned' }}</span></div>
                </div>
                <div class="kb-card-footer">
                  <span class="kb-state-dot" aria-hidden="true"><Check v-if="c.status === 'done'" :size="12" /></span>
                  <select class="kb-move" :aria-label="`Move card #${c.id}`" :value="c.status" :disabled="busy || loading" :title="busy || loading ? 'Board is updating…' : 'Change card column'" @change="moveCard(c, ($event.target as HTMLSelectElement).value as Status)"><option dir="auto" v-for="[st, label] in columns" :key="st" :value="st">{{ label }}</option></select>
                </div>
              </article>
              <p v-if="!cardLists[status].length && !loading" class="kb-column-empty">{{ cards.some(c => c.status === status) ? 'No matches' : 'No cards' }}</p>
            </div>
            <button class="kb-add" :aria-label="`Add card to ${title}`" :disabled="busy || loading" :title="busy || loading ? 'Board is updating…' : `Add card to ${title}`" @click="openEditor(undefined, status)"><Plus :size="13" />Add card</button>
          </section>
        </div>
      </div>
      <div v-if="editing" class="kb-layer" @pointerdown.self="closeEditor()">
      <form ref="editorDialog" class="kb-editor" role="dialog" aria-modal="true" aria-labelledby="kb-editor-title" novalidate @submit.prevent="saveCard" @keydown="trapFocus">
        <div class="kb-editor-head">
          <h3 id="kb-editor-title">
            <template v-if="editingId === null"><span v-if="projectName" class="kb-crumb">{{ projectName }} /</span>New card</template>
            <template v-else><span class="kb-pdot" :data-priority="form.priority" aria-hidden="true"></span>Edit card <span class="kb-card-id">#{{ editingId }}</span></template>
          </h3>
          <button v-if="editingCard" type="button" class="kb-button kb-attach" :disabled="busy" @click="chooseFiles()"><Paperclip :size="14" />Attach files</button>
          <button type="button" class="kb-icon" aria-label="Close card editor" :disabled="busy" @click="closeEditor()"><X :size="17" /></button>
        </div>
        <p v-if="editingArchived" class="kb-archived-note"><Archive :size="14" />This card is archived. Restore it to edit.</p>
        <p v-if="formBanner" class="kb-editor-error" role="alert"><CircleAlert :size="14" />{{ formBanner }}</p>
        <div class="kb-editor-body">
          <div class="kb-editor-main">
            <label class="kb-field"><span>Subject <span class="kb-req" aria-hidden="true">*</span></span>
              <span class="kb-counted">
                <input dir="auto" ref="editorTitle" data-field="subject" v-model="form.subject" aria-label="Card title" required :disabled="readOnly" :aria-invalid="!!fieldErrors.subject" :aria-describedby="fieldErrors.subject ? 'kb-err-subject' : undefined" @focus="subjectFocus = true" @blur="trimSubject" @input="fieldErrors.subject && validate('subject')" />
                <small v-if="subjectFocus || subjectLength > 180" class="kb-counter" :class="{ 'kb-cap': subjectLength === 200, 'kb-over': subjectLength > 200 }" aria-live="polite">{{ subjectLength }}/200</small>
              </span>
              <small v-if="fieldErrors.subject" id="kb-err-subject" class="kb-field-error">{{ fieldErrors.subject }}</small>
            </label>
            <label class="kb-field">Description
              <textarea dir="auto" data-field="description" v-model="form.description" aria-label="Description" rows="4" :disabled="readOnly" :aria-invalid="!!fieldErrors.description" :aria-describedby="fieldErrors.description ? 'kb-err-description' : undefined" @blur="validate('description')"></textarea>
              <small v-if="form.description.length > 7500" class="kb-counter-line" :class="{ 'kb-over': form.description.length > 8000 }">{{ form.description.length.toLocaleString() }}/8,000</small>
              <small v-if="fieldErrors.description" id="kb-err-description" class="kb-field-error">{{ fieldErrors.description }}</small>
            </label>
            <div class="kb-field">
              <span id="kb-labels-label">Labels</span>
              <div class="kb-chips" :class="{ 'kb-invalid': fieldErrors.labels }" @click.self="labelInput?.focus()">
                <span v-for="l in form.labels" :key="l" class="kb-chip" :class="{ 'kb-pulse': pulseLabel === l }" @animationend="pulseLabel = ''"><bdi>{{ l }}</bdi><button type="button" :aria-label="`Remove label ${l}`" :disabled="readOnly" @click="removeLabel(l)"><X :size="12" /></button></span>
                <input ref="labelInput" dir="auto" data-field="labels" v-model="labelDraft" role="combobox" aria-labelledby="kb-labels-label" aria-autocomplete="list" aria-controls="kb-label-list" :aria-expanded="labelOpen && labelOptions.length > 0" :aria-activedescendant="labelOpen && labelOptions.length ? 'kb-label-' + labelActive : undefined" :aria-invalid="!!fieldErrors.labels" :aria-describedby="fieldErrors.labels ? 'kb-err-labels' : 'kb-help-labels'" :placeholder="form.labels.length ? 'Add label…' : 'web, runtime'" :disabled="readOnly || form.labels.length >= 20" @focus="labelOpen = true" @input="labelOpen = true; labelActive = 0" @blur="labelOpen = false; labelDraft.trim() && commitLabels(labelDraft)" @keydown="labelKey" @paste="labelPaste" />
                <ul v-if="labelOpen && labelOptions.length" id="kb-label-list" :ref="revealList" class="kb-options" role="listbox" aria-label="Labels in use">
                  <li v-for="(l, i) in labelOptions" :id="'kb-label-' + i" :key="l" role="option" :aria-selected="i === labelActive" @pointerdown.prevent="commitLabels(l)"><bdi>{{ l }}</bdi></li>
                </ul>
              </div>
              <small v-if="fieldErrors.labels" id="kb-err-labels" class="kb-field-error">{{ fieldErrors.labels }}</small>
              <small v-else id="kb-help-labels">Enter or comma adds a label. Up to 20 labels, 40 characters each.</small>
            </div>
            <div class="kb-field kb-deps">
              <span id="kb-deps-label">Waits on</span>
              <div class="kb-chips" :class="{ 'kb-invalid': fieldErrors.blockedBy }" @click.self="depInput?.focus()">
                <span v-for="id in form.blockedBy" :key="id" class="kb-chip kb-dep-chip"><span class="kb-card-id">#{{ id }}</span><bdi v-if="depLabel(id)">{{ depLabel(id) }}</bdi><button type="button" :aria-label="`Remove dependency #${id}`" :disabled="readOnly" @click="removeDep(id)"><X :size="12" /></button></span>
                <input ref="depInput" dir="auto" data-field="blockedBy" v-model="depQuery" role="combobox" aria-labelledby="kb-deps-label" aria-autocomplete="list" aria-controls="kb-dep-list" :aria-expanded="depOpen && !!depQuery.trim()" :aria-activedescendant="depOpen && depOptions.length ? 'kb-dep-' + depActive : undefined" :aria-invalid="!!fieldErrors.blockedBy" :aria-describedby="fieldErrors.blockedBy ? 'kb-err-deps' : 'kb-help-deps'" placeholder="Search by #id or subject…" :disabled="readOnly || form.project !== selectedPid" @focus="depOpen = true" @input="depOpen = true; depActive = 0" @blur="depOpen = false" @keydown="depKey" />
                <ul v-if="depOpen && depQuery.trim()" id="kb-dep-list" :ref="revealList" class="kb-options" role="listbox" aria-label="Cards in this project">
                  <li v-for="(c, i) in depOptions" :id="'kb-dep-' + i" :key="c.id" role="option" :aria-selected="i === depActive" :aria-disabled="c.id === editingId" @pointerdown.prevent="addDep(c)"><span class="kb-dot" :class="c.status"></span><span class="kb-card-id">#{{ c.id }}</span><bdi>{{ c.subject }}</bdi><small v-if="c.id === editingId"><LockKeyhole :size="11" />this card</small><small v-else>{{ c.status.replace('_', ' ') }}</small></li>
                  <li v-if="!depOptions.length" class="kb-option-empty" role="option" aria-disabled="true">No cards match "{{ depQuery.trim() }}". Try a card ID (#17).</li>
                </ul>
              </div>
              <small v-if="fieldErrors.blockedBy" id="kb-err-deps" class="kb-field-error">{{ fieldErrors.blockedBy }}</small>
              <small v-else id="kb-help-deps">{{ form.project !== selectedPid ? 'Dependencies stay in the current project.' : 'Cards in this project that must be done first.' }}</small>
            </div>
            <div v-if="editingCard?.blocked" class="kb-answer">
              <p class="kb-blocked kb-asks"><CircleAlert :size="13" /><span><strong>Blocked</strong> · <bdi>{{ editingCard.blocked }}</bdi></span></p>
              <label>Answer<textarea dir="auto" v-model="answer" aria-label="Answer" rows="3" maxlength="2000" :disabled="readOnly"></textarea><small>{{ editingCard.owner && /^session \d+$/.test(editingCard.owner) ? `Sent to ${editingCard.owner}. The card is unblocked.` : 'This card has no session owner. The card is unblocked, nobody is notified.' }}</small></label>
              <button type="button" class="kb-button" aria-label="Send answer" :disabled="readOnly || !answer.trim()" @click="sendAnswer">Send answer</button>
            </div>
            <div v-if="editingCard" class="kb-files">
              <span class="kb-files-title">Attachments</span>
              <ul v-if="editingCard.attachments.length"><li v-for="a in editingCard.attachments" :key="a.id"><BoardImage v-if="/^image\/(png|jpeg|gif|webp|avif|bmp)$/i.test(a.type)" :path="attachPath(editingCard.id, a.id)" :name="a.name" /><Paperclip v-else :size="13" /><span dir="auto" class="kb-file-name">{{ a.name }}</span><small>{{ sizeText(a.size) }}</small><button type="button" class="kb-icon" :aria-label="`Download ${a.name}`" @click="downloadFile(editingCard.id, a)"><Download :size="14" /></button><button type="button" class="kb-icon" :aria-label="`Remove ${a.name}`" :disabled="busy" @click="removeFile(editingCard.id, a)"><X :size="14" /></button></li></ul>
              <input ref="fileInput" type="file" multiple hidden aria-label="Attach files" :disabled="busy" @change="attachFiles" />
              <small>Up to 20 files per card, 10 MB each.</small>
            </div>
            <ul v-if="activity.length" class="kb-activity" aria-label="Activity"><li class="vl vl-sm" v-for="a in activity" :key="a.id"><time>{{ new Date(a.at).toLocaleString() }}</time> <strong>{{ a.by }}</strong> <bdi>{{ a.text }}</bdi></li></ul>
          </div>
          <div class="kb-editor-meta">
            <fieldset class="kb-status-group" :disabled="readOnly">
              <legend>Status</legend>
              <label v-for="[s, title] in columns" :key="s" class="kb-radio" :class="{ 'kb-checked': form.status === s }"><input type="radio" name="kb-status" :value="s" v-model="form.status" /><span class="kb-dot" :class="s"></span>{{ title }}<small v-if="s === 'done'" class="kb-tag-hint">releases owner</small></label>
            </fieldset>
            <fieldset class="kb-priority-group" :disabled="readOnly">
              <legend>Priority</legend>
              <label v-for="p in priorities" :key="p" class="kb-priority-chip" :data-priority="p" :class="{ 'kb-checked': form.priority === p }"><input type="radio" name="kb-priority" :value="p" v-model="form.priority" /><ChevronsUp v-if="p === 'urgent'" :size="12" /><ArrowUp v-else-if="p === 'high'" :size="12" /><ArrowDown v-else-if="p === 'low'" :size="12" /><Minus v-else :size="12" />{{ p }}</label>
            </fieldset>
            <div class="kb-field">
              <label for="kb-owner">Owner</label>
              <select id="kb-owner" v-model="ownerSelection" aria-label="Owner" :disabled="readOnly" aria-describedby="kb-owner-status kb-owner-hint">
                <option value="owner:">Unassigned</option>
                <option value="owner:user">User</option>
                <optgroup v-if="ownerSessions.length" label="Agent sessions">
                  <option v-for="s in ownerSessions" :key="s.id" :value="`owner:session ${s.id}`">Agent · {{ s.title || 'Untitled' }} (#{{ s.id }})</option>
                </optgroup>
                <optgroup v-if="ownerOptions.length" label="Other owners">
                  <option v-for="o in ownerOptions" :key="o" :value="`owner:${o}`">{{ o }}</option>
                </optgroup>
                <option value="custom">Custom owner…</option>
              </select>
              <input v-if="customOwner" dir="auto" v-model="form.owner" aria-label="Custom owner" maxlength="100" placeholder="Owner name" :disabled="readOnly" @input="ownerTouched = true" />
              <small id="kb-owner-status" role="status">{{ ownersLoading ? 'Loading agent sessions…' : ownersError ? `Could not load agent sessions: ${ownersError}` : !ownerSessions.length ? 'No agent sessions in this project.' : '' }}</small>
              <button v-if="ownersError" type="button" class="kb-button" :disabled="readOnly" @click="loadOwners">Retry agent sessions</button>
              <small id="kb-owner-hint" :class="{ 'kb-hint': ownerHint }" aria-live="polite"><template v-if="ownerHint"><CircleAlert :size="12" />{{ ownerHint }}</template></small>
            </div>
            <div class="kb-auto-field" :class="{ 'kb-auto-on': form.auto }">
              <div class="kb-auto-head">
                <span id="kb-auto-label" class="kb-auto-title"><Bot :size="14" />Automatic run</span>
                <button
                  type="button"
                  role="switch"
                  class="kb-switch"
                  :aria-checked="form.auto"
                  aria-labelledby="kb-auto-label"
                  aria-describedby="kb-auto-hint"
                  :disabled="readOnly"
                  @click="form.auto = !form.auto"
                ><span class="kb-switch-thumb" /></button>
              </div>
              <small id="kb-auto-hint">{{ form.auto ? 'Owner becomes agent. In To do, runs in its own session without asking. Merge, deploy, or spend only if the description says so.' : 'Off: waits for you or a session to pick it up.' }}</small>
              <div v-if="form.auto" class="kb-auto-opts">
                <div class="kb-auto-opt">
                  <span class="kb-auto-opt-label">Model</span>
                  <ModelCombobox v-model="form.autoModel" empty-label="Project default model" aria-label="Model for the automatic run" :disabled="readOnly" />
                </div>
                <label class="kb-auto-opt">
                  <span class="kb-auto-opt-label">Thinking</span>
                  <select v-model="form.autoThinking" aria-label="Thinking level for the automatic run" :disabled="readOnly">
                    <option value="">Default thinking</option>
                    <option v-for="l in LEVELS" :key="l" :value="l">{{ l }}</option>
                  </select>
                </label>
              </div>
            </div>
            <label v-if="editingId !== null && history.projects.length > 1" class="kb-field">Project<select v-model="form.project" aria-label="Project" :disabled="readOnly" @change="moveDraft"><option v-for="p in history.projects" :key="p.id" :value="String(p.id)">{{ p.name }}</option></select><small>Moving drops this project's dependencies and releases the session owner.</small></label>
            <p v-if="editingCard" class="kb-timestamp"><span class="kb-card-id">#{{ editingCard.id }}</span> · created {{ new Date(editingCard.created).toLocaleString() }}<br />updated {{ new Date(editingCard.updated).toLocaleString() }}</p>
          </div>
        </div>
        <div v-if="discardAsk" class="kb-editor-actions kb-discard" role="alertdialog" aria-label="Discard changes?">
          <span>Discard unsaved changes?</span><button type="button" class="kb-button kb-primary" @click="discardAsk = false; editorTitle?.focus()">Keep editing</button><button type="button" class="kb-button kb-danger" @click="closeEditor(true)">Discard</button>
        </div>
        <div v-else class="kb-editor-actions">
          <template v-if="editingId !== null"><button type="button" class="kb-button" :disabled="busy" @click="setArchived">{{ editingArchived ? 'Restore' : 'Archive' }}</button><button type="button" class="kb-button kb-danger" :disabled="busy" @click="deleteCard">Delete</button></template>
          <span></span>
          <button type="button" class="kb-button" :disabled="busy" @click="closeEditor()">Cancel</button>
          <button v-if="!editingArchived" type="submit" class="kb-button kb-primary" :disabled="busy || !form.subject.trim()" :title="form.subject.trim() ? 'Save (Ctrl+Enter)' : 'Add a subject to continue'"><RefreshCw v-if="busy" class="kb-saving-icon" :size="14" />{{ busy ? 'Saving…' : editingId === null ? 'Create card' : 'Save changes' }}</button>
        </div>
      </form>
      </div>
    </div>
    <footer class="kb-statusbar" :class="{ 'kb-status-error': error, 'kb-status-success': notice && !error && !busy && !loading && !drag?.moved && !editing }" aria-label="Board status">
      <div class="kb-feedback" :role="error ? 'alert' : 'status'" aria-atomic="true">
        <CircleAlert v-if="error" :size="15" /><RefreshCw v-else-if="busy || loading" class="kb-saving-icon" :size="14" /><ArrowRight v-else-if="drag?.moved" :size="14" /><Check v-else-if="notice && !editing" :size="15" />
        <span class="kb-feedback-text">{{ feedbackText }}</span>
        <button v-if="error && !editing && !busy" class="kb-link" @click="loadProjects({ force: true }).then(() => loadBoard(false)).catch(e => error = message(e))">Retry</button>
      </div>
      <span v-if="selectedPid" class="kb-status-count">{{ visible.length }}{{ visible.length !== cards.length ? ' / ' + cards.length : '' }} {{ cards.length === 1 ? 'card' : 'cards' }}</span>
    </footer>
    <Teleport to="body"><div v-if="drag?.moved" class="kb-ghost" :style="{ left: drag.x + 12 + 'px', top: drag.y + 12 + 'px' }" aria-hidden="true"><small>#{{ drag.card.id }}</small><strong dir="auto">{{ drag.card.subject }}</strong></div></Teleport>
  </section>
</template>

<style scoped>
.kb { position:relative; container:kb / inline-size; height:100%; min-height:0; min-width:0; display:flex; flex-direction:column; padding:18px 20px 20px; gap:14px; font-size:14px; color:var(--foreground); background:var(--background); }
.kb *, .kb-ghost { box-sizing:border-box; }
.kb button, .kb select { cursor:pointer; }
.kb button:disabled, .kb select:disabled { cursor:default; opacity:.45; }
.kb button, .kb input, .kb textarea, .kb select { font:inherit; }
.kb input, .kb textarea, .kb select { color:inherit; border:1px solid var(--input); border-radius: var(--radius); background:var(--card); padding:8px 10px; min-width:0; max-width:100%; }
.kb select { text-overflow:ellipsis; }
.kb-button, .kb-icon { display:inline-flex; align-items:center; justify-content:center; gap:7px; border:1px solid var(--border); background:var(--card); color:inherit; border-radius: var(--radius); padding:7px 11px; min-height:34px; line-height:1.3; }
.kb-button:hover:not(:disabled), .kb-icon:hover:not(:disabled) { border-color:var(--muted-foreground); background:var(--secondary); }
.kb-button:focus-visible, .kb-icon:focus-visible, .kb-add:focus-visible, .kb-card-title:focus-visible, .kb-move:focus-visible, .kb-link:focus-visible, .kb-chip button:focus-visible, .kb-archive-card:focus-visible { outline:2px solid var(--ring); outline-offset:2px; }
.kb .kb-primary { background:var(--primary); color:var(--primary-foreground); border-color:var(--primary); }
.kb .kb-primary:hover:not(:disabled) { background:var(--acc-strong); }
.kb-icon { width:34px; flex:none; padding:7px; }
.kb-toolbar { display:flex; align-items:center; gap:12px; flex-wrap:wrap; flex:none; }
.kb-project { min-width:0; flex:0 1 190px; max-width:240px; }
.kb-project select { width:100%; }
.kb-filters { display:flex; align-items:center; gap:8px; flex:1; min-width:280px; }
.kb-filters > select { flex:0 1 145px; }
.kb-search { display:flex; align-items:center; gap:8px; border:1px solid var(--border); border-radius: var(--radius); padding-left:10px; flex:1; max-width:340px; min-width:120px; color:var(--muted-foreground); }
.kb-search input { border:0; background:transparent; width:100%; }
.kb-search:focus-within { outline:2px solid var(--ring); outline-offset:2px; }
.kb-search input:focus-visible { outline:2px solid var(--ring); outline-offset:-2px; }
.kb-toolbar-end { margin-left:auto; display:flex; flex-wrap:wrap; gap:8px; }
.kb-statusbar { margin-top:auto; height:36px; min-height:36px; flex:none; display:flex; align-items:center; justify-content:space-between; gap:16px; border-top:1px solid var(--border); font-size:12px; color:var(--muted-foreground); padding:7px 2px 0; }
.kb-feedback { display:flex; align-items:center; gap:8px; margin:0; min-width:0; flex:1; height:100%; }
.kb-feedback > svg { flex:none; }
.kb-feedback-text { min-width:0; white-space:nowrap; overflow:auto; scrollbar-width:thin; }
.kb-status-count { flex:none; font-variant-numeric:tabular-nums; }
.kb-status-error { color:var(--destructive); }
.kb-status-success { color:var(--success); }
.kb-link { text-decoration:underline; flex:none; min-height:28px; }
.kb-saving-icon { animation:kb-spin 1.5s linear infinite; }
@keyframes kb-spin { to { transform:rotate(360deg); } }
@media(prefers-reduced-motion:reduce) { .kb-saving-icon { animation:none; } }
.kb-workspace { flex:1; min-height:0; min-width:0; display:flex; gap:16px; }
.kb-content { flex:1; min-width:0; min-height:0; display:flex; }
.kb-board { flex:1; display:flex; gap:14px; overflow-x:auto; overflow-y:hidden; min-height:0; min-width:0; padding:3px 3px 12px; scrollbar-width:thin; overscroll-behavior:contain; }
.kb-column { min-width:210px; flex:1 0 210px; display:flex; flex-direction:column; min-height:0; border-right:1px solid var(--border); padding:0 12px 0 0; border-radius: var(--radius); }
.kb-column:last-child { border-right-color:transparent; }
.kb-column-title { display:flex; align-items:center; gap:8px; padding:8px 2px 14px; margin:0; text-transform:uppercase; font-size:12px; font-weight:650; letter-spacing:.06em; flex:none; }
.kb-dot { width:6px; height:6px; flex:none; background:var(--muted-foreground); border-radius:50%; }
.kb-dot.todo { background:var(--info); }.kb-dot.in_progress { background:var(--warning); }.kb-dot.review { background:var(--violet); }.kb-dot.done { background:var(--success); }
.kb-count { margin-left:auto; color:var(--muted-foreground); font-variant-numeric:tabular-nums; font-weight:500; padding:2px 6px; background:var(--secondary); border-radius: var(--radius); }
.kb-cards { overflow-y:auto; overflow-x:hidden; scrollbar-width:thin; flex:1; min-height:70px; padding:1px 3px 5px; overscroll-behavior:contain; }
.kb-card { --priority-color:var(--muted-foreground); --status-color:var(--muted-foreground); display:flex; flex-direction:column; border:1px solid var(--input); border-left:3px solid var(--priority-color); border-radius: var(--radius); background:var(--card); margin-bottom:10px; min-width:0; overflow:hidden; overflow-wrap:anywhere; }
.kb-card[data-priority="urgent"] { --priority-color:var(--destructive); }
.kb-card[data-priority="high"] { --priority-color:var(--warning); }
.kb-card[data-priority="medium"] { --priority-color:var(--info); }
.kb-card[data-priority="low"] { --priority-color:var(--muted-foreground); }
.kb-card[data-status="todo"] { --status-color:var(--info); }
.kb-card[data-status="in_progress"] { --status-color:var(--warning); }
.kb-card[data-status="review"] { --status-color:var(--violet); }
.kb-card[data-status="done"] { --status-color:var(--success); background:color-mix(in srgb,var(--success) 3%,var(--card)); }
.kb-card:hover { border-top-color:color-mix(in srgb,var(--foreground) 30%,var(--border)); border-right-color:color-mix(in srgb,var(--foreground) 30%,var(--border)); border-bottom-color:color-mix(in srgb,var(--foreground) 30%,var(--border)); }
.kb-card-body { padding:10px 12px 12px; flex:1; min-width:0; }
.kb-card-top { touch-action:none; user-select:none; cursor:grab; display:flex; align-items:center; gap:7px; min-height:28px; }
.kb-card-id { margin-right:auto; color:var(--muted-foreground); font:12px var(--mono); }
.kb-grip { touch-action:none; user-select:none; cursor:grab!important; display:grid; place-items:center; width:26px; height:28px; flex:none; background:transparent; border:0; border-radius: var(--radius); color:var(--muted-foreground); }
.kb-card-top:hover .kb-grip { color:var(--primary-text); background:var(--secondary); }
.kb-card-heading { display:flex; align-items:flex-start; gap:8px; }
.kb-card-heading .kb-card-attach { flex:none; margin-top:5px; }
.kb-card-title { display:block; flex:1; min-width:0; text-align:start; font-weight:600!important; font-size:14.5px!important; line-height:1.55; letter-spacing:.005em; padding:7px 0 10px; background:transparent; border:0; overflow-wrap:anywhere; }
.kb-card-title:hover { color:var(--primary-text); }
.kb-description { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; line-clamp:2; overflow:hidden; color:var(--muted-foreground); font-size:12.5px; font-weight:440; line-height:1.6; margin:0 0 10px; white-space:pre-wrap; }
.kb-priority { display:inline-flex; align-items:center; gap:3px; border-radius: var(--radius); padding:3px 5px; font-size:11px; line-height:1; text-transform:capitalize; color:var(--sidebar-foreground); background:var(--secondary); white-space:nowrap; }
.kb-priority.high { color:var(--warning); background:color-mix(in srgb,var(--warning) 14%,var(--card)); }
.kb-priority.urgent { color:var(--destructive); background:color-mix(in srgb,var(--destructive) 16%,var(--card)); }
.kb-priority.medium { color:var(--info); background:color-mix(in srgb,var(--info) 16%,var(--card)); }
.kb-priority.low { color:var(--sidebar-foreground); background:var(--secondary); }
.kb-priority svg { flex:none; }
.kb-labels { display:flex; align-items:center; gap:5px; flex-wrap:wrap; margin:0 0 12px; }
.kb-tag { border:1px solid var(--input); background:var(--secondary); padding:2px 7px; border-radius: var(--radius); color:var(--foreground); font-size:11px; line-height:1.4; max-width:100%; overflow-wrap:anywhere; }
.kb-owner { display:flex; align-items:flex-start; gap:6px; font-size:12px; color:var(--sidebar-foreground); overflow-wrap:anywhere; }
.kb-owner svg { flex:none; margin-top:2px; }
.kb-owner span { min-width:0; }
.kb-unassigned { color:var(--muted-foreground); }
.kb-blocked { display:flex; align-items:flex-start; gap:6px; color:var(--warning); background:color-mix(in srgb,var(--warning) 12%,var(--card)); border:1px solid color-mix(in srgb,var(--warning) 30%,var(--card)); padding:7px; border-radius: var(--radius); font-size:11px; line-height:1.5; margin:0 0 12px; }
.kb-blocked strong { font-weight:600; }
.kb-blocked svg { flex:none; margin-top:1px; }
.kb-card-footer { display:flex; align-items:center; gap:7px; border-top:1px solid var(--border); background:color-mix(in srgb,var(--status-color) 5%,var(--background)); padding:4px 9px; margin-top:auto; }
.kb-card-attach { width:auto; min-width:32px; min-height:32px; padding:4px 6px; font-size:11px!important; border-color:transparent; background:transparent; }
.kb-state-dot { width:12px; height:12px; flex:none; display:grid; place-items:center; color:var(--status-color); }
.kb-state-dot:empty::after { content:''; width:6px; height:6px; background:currentColor; border-radius:50%; }
.kb .kb-move { width:100%; min-width:0; font-size:12px; color:var(--status-color); border:1px solid transparent; padding:5px 0; background:transparent; border-radius: var(--radius); }
.kb .kb-move:hover:not(:disabled) { background:var(--secondary); }
.kb-add { display:flex; gap:6px; align-items:center; border:1px dashed var(--input); border-radius: var(--radius); padding:8px 10px; margin:10px 3px 0; color:var(--muted-foreground); text-align:left; background:transparent; font-size:12px!important; flex:none; }
.kb-add:hover { color:var(--primary-text); border-color:var(--primary-text); }
.kb-column-empty { color:var(--muted-foreground); font-size:12px; padding:10px 2px; }
.kb-drop { background:var(--acc-soft); outline:2px solid var(--primary); outline-offset:-2px; }
.kb-drag-source { opacity:.3; }
.kb-ghost { position:fixed; z-index:60; width:200px; padding:12px; border:1px solid var(--primary); border-radius: var(--radius); background:var(--card); color:var(--foreground); pointer-events:none; box-shadow:var(--shadow); overflow-wrap:anywhere; }.kb-ghost small { color:var(--muted-foreground); font:11px var(--mono); display:block; margin-bottom:8px; }.kb-ghost strong { font:550 13.5px/1.5 system-ui,sans-serif; }
.kb-empty { margin:auto; padding:24px; text-align:center; color:var(--muted-foreground); }.kb-empty p { margin-bottom:14px; }
.kb-archive { flex:1; min-width:0; overflow:auto; }.kb-archive-card { display:flex; gap:16px; align-items:center; text-align:left; width:100%; border:1px solid var(--border); border-radius: var(--radius); background:var(--card); padding:12px; margin-bottom:8px; overflow-wrap:anywhere; }.kb-archive-card strong { flex:1; min-width:0; font-weight:500; }.kb-archive-card>span { color:var(--muted-foreground); font-size:12px; }
.kb-layer { position:absolute; inset:0; z-index:5; display:grid; place-items:center; padding:12px; background:color-mix(in srgb,var(--background) 70%,transparent); }
.kb-editor { display:flex; flex-direction:column; width:min(720px,100%); max-height:min(100%, 80vh); min-height:0; border:1px solid var(--border); border-radius: var(--radius); background:var(--card); box-shadow:var(--shadow); animation:kb-in 160ms cubic-bezier(.2,0,0,1); }
@keyframes kb-in { from { opacity:0; transform:scale(.98); } }
.kb-editor-head { display:flex; align-items:center; gap:8px; padding:12px 16px; border-bottom:1px solid var(--border); flex:none; }
.kb-editor-head h3 { margin:0; font-weight:600; flex:1; min-width:0; display:flex; align-items:center; gap:8px; overflow-wrap:anywhere; }
.kb-crumb { color:var(--muted-foreground); font-weight:450; }
.kb-pdot { width:8px; height:8px; flex:none; border-radius:50%; background:var(--muted-foreground); }
.kb-pdot[data-priority="urgent"] { background:var(--destructive); }.kb-pdot[data-priority="high"] { background:var(--warning); }.kb-pdot[data-priority="medium"] { background:var(--info); }
.kb-editor-head .kb-card-id { margin:0; font-weight:450; font-size:13px; }
.kb-archived-note { display:flex; align-items:center; gap:7px; margin:0; padding:8px 16px; border-bottom:1px solid var(--border); font-size:12px; color:var(--warning); background:color-mix(in srgb,var(--warning) 10%,var(--card)); flex:none; }
.kb-editor-body { flex:1; min-height:0; overflow:auto; display:grid; grid-template-columns:minmax(0,1fr) 240px; scrollbar-width:thin; }
.kb-editor-main { display:grid; align-content:start; gap:16px; padding:16px; min-width:0; }
.kb-editor-meta { display:grid; align-content:start; gap:20px; padding:16px; border-left:1px solid var(--border); background:color-mix(in srgb,var(--background) 40%,var(--card)); min-width:0; }
.kb-editor label, .kb-field { display:grid; gap:6px; font-size:13px; min-width:0; }
.kb-editor input, .kb-editor textarea, .kb-editor select { width:100%; background:var(--background); }
.kb-project select:focus-visible, .kb-filters > select:focus-visible, .kb-editor input:focus-visible, .kb-editor textarea:focus-visible, .kb-editor select:focus-visible { outline:2px solid var(--ring); outline-offset:2px; }
.kb-editor [data-field="subject"] { font-size:15px; font-weight:600; padding-right:62px; }
.kb-editor textarea { resize:vertical; min-height:80px; max-height:calc(12lh + 18px); field-sizing:content; font-size:14px; line-height:1.5; }
.kb-editor small { font-size:11px; color:var(--muted-foreground); line-height:1.5; }
.kb-editor [aria-invalid="true"], .kb-chips.kb-invalid { border-color:var(--destructive); }
.kb-editor .kb-field-error { color:var(--destructive); font-size:12px; }
.kb-req { color:var(--destructive); }
.kb-counted { position:relative; display:block; }
.kb-editor .kb-counter { position:absolute; right:10px; top:50%; transform:translateY(-50%); font-variant-numeric:tabular-nums; pointer-events:none; }
.kb-editor .kb-counter-line { justify-self:end; font-variant-numeric:tabular-nums; }
.kb-editor .kb-cap { color:var(--warning); }.kb-editor .kb-over { color:var(--destructive); }
.kb-chips { position:relative; display:flex; flex-wrap:wrap; align-items:center; gap:5px; padding:5px; min-height:38px; border:1px solid var(--input); border-radius: var(--radius); background:var(--background); cursor:text; }
.kb-chips:focus-within { outline:2px solid var(--ring); outline-offset:1px; }
.kb-editor .kb-chips input { flex:1; min-width:120px; width:auto; border:0; padding:3px 4px; background:transparent; outline:none; }
.kb-chip { display:inline-flex; align-items:center; gap:4px; max-width:100%; padding:2px 2px 2px 7px; border:1px solid var(--input); border-radius: var(--radius); background:var(--secondary); font-size:12px; line-height:1.4; overflow-wrap:anywhere; animation:kb-pop 120ms ease-out; }
.kb-chip button { display:grid; place-items:center; width:24px; height:24px; padding:0; border:0; background:transparent; color:var(--muted-foreground); border-radius: var(--radius); }
.kb-chip button:hover:not(:disabled) { color:var(--foreground); background:var(--card); }
.kb-dep-chip .kb-card-id { margin:0; font-size:11px; }
.kb-dep-chip bdi { max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.kb-pulse { animation:kb-pulse 600ms ease-out; }
@keyframes kb-pop { from { transform:scale(.9); opacity:.4; } }
@keyframes kb-pulse { 30% { border-color:var(--primary); background:var(--acc-soft); } }
.kb-options { flex:1 0 100%; margin:2px 0 0; padding:4px; list-style:none; max-height:200px; overflow:auto; border-top:1px solid var(--border); background:var(--background); }
.kb-options li { display:flex; align-items:center; gap:7px; padding:7px 8px; border-radius: var(--radius); font-size:13px; cursor:pointer; min-width:0; }
.kb-options li bdi { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.kb-options li .kb-card-id { margin:0; flex:none; }
.kb-options li small { flex:none; display:inline-flex; align-items:center; gap:3px; }
.kb-options li[aria-selected="true"] { background:var(--secondary); }
.kb-options li[aria-disabled="true"] { cursor:default; opacity:.55; background:transparent; }
.kb-editor fieldset { border:0; margin:0; padding:0; min-width:0; }
.kb-editor legend { font-size:13px; padding:0; margin-bottom:6px; }
.kb-status-group { display:grid; gap:2px; }
.kb-editor .kb-radio { display:flex; align-items:center; gap:8px; padding:6px 8px; border:1px solid transparent; border-radius: var(--radius); cursor:pointer; font-size:13px; }
.kb-editor .kb-radio:hover { background:var(--secondary); }
.kb-editor .kb-radio.kb-checked { border-color:var(--input); background:var(--background); font-weight:550; }
.kb-editor .kb-radio input, .kb-editor .kb-priority-chip input { position:absolute; opacity:0; width:1px; height:1px; pointer-events:none; }
.kb-editor .kb-radio:has(input:focus-visible), .kb-editor .kb-priority-chip:has(input:focus-visible) { outline:2px solid var(--ring); outline-offset:1px; }
.kb-editor .kb-tag-hint { margin-left:auto; font-size:10.5px; font-weight:400; }
.kb-priority-group { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.kb-priority-group legend { grid-column:1 / -1; }
.kb-editor .kb-priority-chip { display:flex; align-items:center; justify-content:center; gap:4px; padding:6px; border:1px solid var(--input); border-radius: var(--radius); font-size:12px; text-transform:capitalize; cursor:pointer; color:var(--sidebar-foreground); background:var(--background); }
.kb-editor .kb-priority-chip[data-priority="urgent"] { --pc:var(--destructive); }.kb-editor .kb-priority-chip[data-priority="high"] { --pc:var(--warning); }.kb-editor .kb-priority-chip[data-priority="medium"] { --pc:var(--info); }.kb-editor .kb-priority-chip[data-priority="low"] { --pc:var(--muted-foreground); }
.kb-editor .kb-priority-chip.kb-checked { color:var(--pc); border-color:var(--pc); background:color-mix(in srgb,var(--pc) 14%,var(--card)); font-weight:600; }
.kb-editor fieldset:disabled label { cursor:default; opacity:.6; }
.kb-editor .kb-hint { display:flex; align-items:flex-start; gap:5px; color:var(--warning); }
.kb-editor .kb-hint svg { flex:none; margin-top:2px; }
.kb-timestamp { font-size:11px; color:var(--muted-foreground); margin:0; line-height:1.6; }
.kb-timestamp .kb-card-id { margin:0; font-size:11px; }
.kb-editor-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:12px 16px; border-top:1px solid var(--border); flex:none; }.kb-editor-actions>span { flex:1; }.kb .kb-danger { color:var(--destructive); }
.kb-discard > span { font-size:13px; }
.kb-answer { display:grid; gap:8px; }
.kb-editor-error { display:flex; align-items:flex-start; gap:6px; margin:0; padding:8px 16px; border-bottom:1px solid var(--border); color:var(--destructive); background:color-mix(in srgb,var(--destructive) 10%,var(--card)); font-size:12px; line-height:1.5; overflow-wrap:anywhere; flex:none; }.kb-editor-error svg { flex:none; margin-top:2px; }
@media(prefers-reduced-motion:reduce) { .kb-editor, .kb-chip, .kb-pulse { animation:none; } }
.kb-files { display:grid; gap:8px; }.kb-files-title { font-size:13px; }.kb-files ul { list-style:none; margin:0; padding:0; display:grid; gap:4px; }.kb-files li { display:flex; align-items:center; gap:6px; font-size:12px; }.kb-file-name { flex:1; min-width:0; overflow-wrap:anywhere; }.kb-files .kb-icon { width:28px; min-height:28px; }.kb-attach { cursor:pointer; justify-self:start; }.kb-attach-off { opacity:.45; pointer-events:none; }
.kb-asks { margin:0; }
.kb-auto { display:flex; align-items:center; gap:6px; margin:0 0 8px; font-size:11px; color:var(--muted-foreground); }
.kb-auto strong { color:var(--foreground); font-weight:600; }
.kb-auto-field { display:grid; gap:8px; padding:10px 12px; border:1px solid var(--border); border-radius:var(--radius); background:var(--background); transition:border-color 140ms ease, background-color 140ms ease; }
.kb-auto-field.kb-auto-on { border-color:color-mix(in srgb,var(--primary) 45%,var(--border)); background:color-mix(in srgb,var(--primary) 6%,var(--background)); }
.kb-auto-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.kb-auto-title { display:inline-flex; align-items:center; gap:6px; font-size:13px; font-weight:550; color:var(--foreground); }
.kb-auto-title svg { color:var(--muted-foreground); flex:none; }
.kb-auto-on .kb-auto-title svg { color:var(--primary-text); }
.kb-switch { position:relative; flex:none; width:40px; height:24px; border-radius:999px; border:1px solid var(--input); background:var(--muted); cursor:pointer; padding:0; transition:background-color 120ms ease, border-color 120ms ease; }
.kb-switch:focus-visible { outline:2px solid var(--ring); outline-offset:2px; }
.kb-switch:disabled { opacity:.45; cursor:default; }
.kb-switch[aria-checked="true"] { background:var(--primary); border-color:var(--primary-text); }
.kb-switch-thumb { position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:var(--foreground); transition:transform 120ms ease, background-color 120ms ease; }
.kb-switch[aria-checked="true"] .kb-switch-thumb { transform:translateX(16px); background:var(--primary-foreground); }
.kb-auto-opts { display:grid; gap:8px; padding-top:8px; border-top:1px solid var(--border); }
.kb-editor .kb-auto-opt { display:grid; gap:4px; font-size:12px; }
.kb-auto-opt-label { font-size:11px; color:var(--muted-foreground); }
.kb-activity { list-style:none; margin:0; padding:10px 0 0; border-top:1px solid var(--border); display:grid; gap:6px; font-size:12px; color:var(--muted-foreground); max-height:180px; overflow:auto; }
.kb-activity time { display:block; font-size:11px; color:var(--muted-foreground); }
.kb-activity strong { color:var(--foreground); font-weight:550; }
.kb-sr { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
@container kb (max-width:1023px) {
  .kb-editor { width:min(560px,100%); }
  .kb-editor-body { display:block; }
  .kb-editor-meta { border-left:0; border-top:1px solid var(--border); grid-template-columns:1fr 1fr; gap:16px; }
  .kb-editor-meta .kb-status-group, .kb-editor-meta .kb-timestamp { grid-column:1 / -1; }
  .kb-status-group { display:flex; gap:6px; overflow-x:auto; scrollbar-width:thin; padding-bottom:2px; }
  .kb-editor .kb-radio { flex:none; border-color:var(--input); white-space:nowrap; }
}
@container kb (max-width:639px) {
  .kb-layer { padding:0; place-items:stretch; }
  .kb-editor { width:100%; max-height:none; height:100%; border:0; }
  .kb-editor-meta { grid-template-columns:1fr; }
  .kb-editor-actions { flex-wrap:nowrap; gap:6px; padding:10px 12px max(10px, env(safe-area-inset-bottom)); }
  .kb-editor-actions .kb-button { padding-inline:10px; }
  .kb-editor-actions>span { display:none; }
  .kb-editor-actions [type="submit"] { margin-left:auto; }
}
@media(max-width:1000px) { .kb-project { flex-basis:150px; }.kb-filters { min-width:260px; } }

@media(max-width:760px) {
  .kb-editing .kb-toolbar { display:none; }
  .kb { padding:10px 12px; gap:8px; }
  .kb-editing { padding-top:8px; padding-bottom:8px; gap:6px; }
  .kb-toolbar { gap:6px; }
  .kb-project { flex:1 1 130px; max-width:none; min-width:0; }
  .kb-project select { min-height:44px; }
  .kb-toolbar-end { flex:none; width:auto; margin-left:auto; gap:6px; }
  .kb-filters { flex:1 0 100%; min-width:0; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:6px; }
  .kb-search { max-width:none; min-width:0; min-height:44px; }
  .kb-filters > select { min-height:44px; max-width:138px; }
  .kb-board { flex-direction:column; overflow-x:hidden; overflow-y:auto; gap:12px; }
  .kb-column { flex:0 0 auto; width:100%; min-width:0; border-right:0; border-bottom:1px solid var(--border); padding:0 0 12px 0; }
  .kb-column:last-child { border-bottom-color:transparent; }
  .kb-archive-card { flex-wrap:wrap; gap:8px; min-height:44px; }
  .kb-grip { min-height:44px; width:44px; }
  .kb-button,.kb-icon,.kb-add,.kb-move { min-height:44px; }
  .kb-icon, .kb-files .kb-icon { min-width:44px; min-height:44px; width:44px; }
  .kb-chip button { min-width:44px; min-height:44px; width:44px; height:44px; }
  .kb-switch::after { content:''; position:absolute; inset:-10px -2px; }
  .kb-statusbar { height:30px; min-height:30px; gap:8px; font-size:11px; padding-top:4px; }
  .kb-status-count { display:none; }
}
</style>
