<script setup lang="ts">
// Ctrl/Cmd+K palette: every entry runs an existing app action or a real settings write.
import { computed, nextTick, ref, shallowRef, toRaw, watch, onUnmounted } from 'vue';
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { Check, Search } from '@lucide/vue';
import { ui, setPalette, navigate, openPanel, toggleCollapsed, settingsDirty, settingsChanged } from '@/stores/app';
import { chat, openSession, scheduleContext } from '@/stores/chat';
import { history, sessionTitle, projectName, querySessions } from '@/stores/sessions';
import type { SessionMeta } from '@/lib/types';
import { models, modelKey, selectedKey, chooseModel, LEVELS, levelLabel, setThinking } from '@/stores/models';
import { PANELS } from '@/components/panels';
import { sections, labelFor, isVisibleSetting, settingRoute } from '@/pages/settings/catalog';
import { fieldLocation } from '@/pages/settings/settingsSearch';
import { json, post, serverUrl, token } from '@/lib/api';
import { useMobile } from '@/lib/dom';

const props = defineProps<{ newSession: () => Promise<void>; newSessionDisabled: boolean }>();

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  /** Short real-state chip, for example On or Off. */
  state?: string;
  current?: boolean;
  /** Reason the entry cannot run now. */
  disabled?: string;
  /** Keep the palette open after the action, so the new state is visible. */
  keep?: boolean;
  run: () => unknown;
}
interface SettingsView { schema: any; config: any; revision: string; restartRequired: boolean }
interface SettingField { path: string[]; kind: 'boolean' | 'enum'; values: string[]; fallback: unknown }

const mobile = useMobile();
const query = ref('');
const active = ref(0);
const status = ref('');
const statusError = ref(false);
const settings = shallowRef<SettingsView | null>(null);
const saving = ref(false);
const listEl = ref<HTMLElement | null>(null);
let loadRequest = 0;
let returnFocus: HTMLElement | null = null;
let restoreOnClose = true;
function restoreFocus() {
  if (restoreOnClose && returnFocus?.isConnected && !returnFocus.closest('[inert]')) returnFocus.focus();
}

const open = computed({ get: () => ui.palette, set: (value: boolean) => setPalette(value) });

watch(() => ui.palette, value => {
  if (!value) return;
  returnFocus = document.activeElement as HTMLElement | null;
  restoreOnClose = true;
  // The dialog stays mounted: refresh shared state on every open, not only on mount.
  query.value = ''; active.value = 0; status.value = ''; statusError.value = false;
  void loadSettings();
});

const sessionOptions = ref<SessionMeta[]>([]);
const sessionLoading = ref(false), sessionError = ref('');
let sessionRead: AbortController | undefined;
async function searchSessions() {
  sessionRead?.abort();
  sessionOptions.value = [];
  sessionError.value = '';
  sessionLoading.value = open.value;
  if (!open.value) return;
  const controller = new AbortController();
  sessionRead = controller;
  // Palette group names are searchable, but they are not session metadata search terms.
  const q = query.value.trim().split(/\s+/).filter(term => !'conversations'.includes(term.toLowerCase())).join(' ');
  try {
    const page = await querySessions({ limit: 50, archived: '0', q }, controller.signal);
    if (sessionRead === controller && !controller.signal.aborted) sessionOptions.value = page.sessions;
  } catch (error: any) {
    if (sessionRead === controller && !controller.signal.aborted) sessionError.value = error.message;
  } finally {
    if (sessionRead === controller) sessionLoading.value = false;
  }
}
watch([open, query, serverUrl, token, () => history.groups], () => { void searchSessions(); }, { flush: 'sync' });
onUnmounted(() => { sessionRead?.abort(); });

async function loadSettings() {
  const request = ++loadRequest;
  try {
    const view = await json<SettingsView>('/v1/settings');
    if (request === loadRequest) settings.value = view;
  } catch {
    // Settings can be disabled on the server; the palette then lists no setting entries.
    if (request === loadRequest) settings.value = null;
  }
}

function fieldsOf(schema: any): SettingField[] {
  const out: SettingField[] = [];
  const walk = (node: any, path: string[]) => {
    if (!node || !path.length && node.type !== 'object') return;
    if (node.type === 'boolean') out.push({ path, kind: 'boolean', values: [], fallback: node.default });
    else if (Array.isArray(node.enum) && node.enum.every((v: unknown) => typeof v === 'string')) out.push({ path, kind: 'enum', values: node.enum, fallback: node.default });
    else if (node.type === 'object' && node.properties) for (const [key, child] of Object.entries(node.properties)) walk(child, [...path, key]);
  };
  walk(schema, []);
  return out;
}
const read = (config: any, path: string[]) => path.reduce<any>((value, key) => value?.[key], config);
const fieldTitle = (path: string[]) => path.length > 1 ? `${labelFor([path[0]!])} · ${labelFor(path)}` : labelFor(path);

async function writeSetting(path: string[], value: unknown) {
  const view = settings.value;
  if (!view || saving.value) return;
  if (settingsDirty()) { status.value = 'Save or discard the edits on the Settings page first.'; statusError.value = true; return; }
  saving.value = true; status.value = ''; statusError.value = false;
  try {
    const config = structuredClone(toRaw(view.config));
    let target = config;
    for (const key of path.slice(0, -1)) { if (target[key] == null) target[key] = {}; target = target[key]; }
    target[path.at(-1)!] = value;
    const next = await post('/v1/settings', { config, revision: view.revision }, 'PUT') as SettingsView;
    settings.value = next;
    settingsChanged.value++;
    scheduleContext();
    status.value = next.restartRequired ? `Saved ${fieldTitle(path)}. Restart Luna to apply this startup setting.` : `Saved ${fieldTitle(path)}.`;
  } catch (e) {
    status.value = (e as Error).message || 'Failed to save the setting.';
    statusError.value = true;
    void loadSettings();
  } finally { saving.value = false; }
}

const items = computed<Item[]>(() => {
  const list: Item[] = [];
  const add = (item: Item) => list.push(item);

  add({ id: 'view:chat', group: 'Go to', label: 'Chat', current: ui.view === 'chat' && !ui.panel, run: () => navigate('chat') });
  add({ id: 'view:analytics', group: 'Go to', label: 'Analytics', current: ui.view === 'analytics', run: () => navigate('analytics') });
  add({ id: 'view:source-control', group: 'Go to', label: 'Source Control', current: ui.view === 'source-control', run: () => navigate('source-control') });
  add({ id: 'view:github', group: 'Go to', label: 'GitHub (alias)', current: ui.view === 'source-control', run: () => navigate('source-control') });
  for (const s of sections) add({ id: 'settings:' + s.id, group: 'Go to', label: 'Settings: ' + s.title, hint: s.description, current: ui.view === 'settings' && ui.settingsTab === s.id, run: () => navigate('settings', s.id) });
  for (const [id, panel] of Object.entries(PANELS)) add({ id: 'panel:' + id, group: 'Open', label: panel.title, hint: panel.desc, current: ui.panel === id, run: () => openPanel(id) });

  if (!mobile.value) add({ id: 'layout:sidebar', group: 'Layout', label: ui.collapsed ? 'Expand sidebar' : 'Collapse sidebar', keep: true, run: toggleCollapsed });

  add({ id: 'session:new', group: 'Conversations', label: 'New conversation', disabled: props.newSessionDisabled ? 'Not available while disconnected' : undefined, run: () => { navigate('chat'); return props.newSession(); } });
  for (const s of sessionOptions.value) {
    if (s.archived) continue;
    const id = String(s.id);
    add({ id: 'session:' + id, group: 'Conversations', label: sessionTitle(s), hint: projectName(s.project), current: id === chat.session, run: () => { navigate('chat'); return openSession(id); } });
  }

  for (const m of models.list) {
    const key = modelKey(m);
    add({ id: 'model:' + key, group: 'Model', label: `${m.provider} · ${m.name || m.id}`, current: key === selectedKey.value, run: () => chooseModel(m) });
  }
  for (const level of LEVELS) add({ id: 'thinking:' + level, group: 'Thinking', label: 'Thinking: ' + levelLabel(level), current: models.thinking === level, keep: true, run: () => setThinking(level) });

  const view = settings.value;
  if (view) {
    const blocked = saving.value ? 'Saving' : undefined;
    for (const field of fieldsOf(view.schema)) {
      if (!isVisibleSetting(field.path)) continue;
      const title = fieldTitle(field.path), id = 'setting:' + field.path.join('.');
      const location = fieldLocation(field.path);
      add({ id: 'open:' + id, group: 'Open setting', label: title, hint: location, run: () => navigate('settings', settingRoute(field.path)) });
      const value = read(view.config, field.path) ?? field.fallback;
      if (field.kind === 'boolean') {
        add({ id, group: 'Settings', label: title, hint: location, state: value ? 'On' : 'Off', disabled: blocked, keep: true, run: () => writeSetting(field.path, !value) });
      } else for (const option of field.values) {
        add({ id: `${id}=${option}`, group: 'Settings', label: `${title}: ${option}`, hint: location, current: value === option, disabled: blocked, keep: true, run: () => writeSetting(field.path, option) });
      }
    }
  }
  return list;
});

const results = computed(() => {
  const terms = query.value.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return items.value;
  return items.value.filter(item => {
    const text = `${item.id} ${item.group} ${item.label} ${item.hint || ''}`.toLowerCase();
    return terms.every(term => text.includes(term));
  });
});
const groups = computed(() => {
  const out: { name: string; items: { item: Item; index: number }[] }[] = [];
  results.value.forEach((item, index) => {
    const last = out.at(-1);
    if (last?.name === item.group) last.items.push({ item, index });
    else out.push({ name: item.group, items: [{ item, index }] });
  });
  return out;
});
watch(query, () => { active.value = 0; });
watch(results, list => { if (active.value >= list.length) active.value = Math.max(0, list.length - 1); });

function scrollActive() {
  void nextTick(() => listEl.value?.querySelector<HTMLElement>(`[data-index="${active.value}"]`)?.scrollIntoView({ block: 'nearest' }));
}
function move(delta: number) {
  const count = results.value.length;
  if (!count) return;
  active.value = (active.value + delta + count) % count;
  scrollActive();
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
  else if (event.key === 'Home' && event.ctrlKey) { event.preventDefault(); active.value = 0; scrollActive(); }
  else if (event.key === 'End' && event.ctrlKey) { event.preventDefault(); active.value = Math.max(0, results.value.length - 1); scrollActive(); }
  else if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); const item = results.value[active.value]; if (item) void runItem(item); }
}

async function runItem(item: Item) {
  if (item.disabled) { status.value = item.disabled; statusError.value = true; return; }
  if (!item.keep) { restoreOnClose = false; setPalette(false); await nextTick(); }
  try { await item.run(); }
  catch (e) {
    if (ui.palette) { status.value = (e as Error).message || 'Command failed.'; statusError.value = true; }
  }
}
const optionId = (index: number) => 'palette-option-' + index;
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-[90] bg-black/60" />
      <DialogContent id="command-palette" class="palette" aria-describedby="palette-desc" @close-auto-focus.prevent="restoreFocus">
        <DialogTitle class="sr-only">Command palette</DialogTitle>
        <DialogDescription id="palette-desc" class="sr-only">Type to filter commands. Use the arrow keys to move and Enter to run.</DialogDescription>
        <div class="palette-search">
          <Search :size="16" aria-hidden="true" />
          <input id="palette-input" dir="auto" v-model="query" type="text" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" :aria-activedescendant="results.length ? optionId(active) : undefined" placeholder="Type a command, page, conversation, or setting" autocomplete="off" spellcheck="false" @keydown="onKeydown" />
          <kbd class="palette-kbd">Esc</kbd>
        </div>
        <div id="palette-list" ref="listEl" class="palette-list" role="listbox" aria-label="Commands">
          <div v-for="group in groups" :key="group.name" class="palette-group" role="group" :aria-label="group.name">
            <div class="palette-group-name" aria-hidden="true">{{ group.name }}</div>
            <div v-for="{ item, index } in group.items" :id="optionId(index)" :key="item.id" class="palette-item vl vl-sm" role="option" :data-command="item.id" :data-index="index" :aria-selected="index === active" :aria-disabled="item.disabled ? 'true' : undefined" :aria-current="item.current ? 'true' : undefined" @pointermove="active = index" @click="runItem(item)">
              <span class="palette-check" aria-hidden="true"><Check v-if="item.current" :size="14" /></span>
              <span class="palette-label" dir="auto">{{ item.label }}</span>
              <span v-if="item.disabled || item.hint" class="palette-hint">{{ item.disabled || item.hint }}</span>
              <span v-if="item.state" class="palette-state" :data-state="item.state">{{ item.state }}</span>
            </div>
          </div>
          <p v-if="!results.length" class="palette-empty">No matching commands.</p>
        </div>
        <p v-if="sessionLoading" class="palette-status" role="status">Searching conversations…</p>
        <p v-else-if="sessionError" class="palette-status" role="alert" data-error>{{ sessionError }} <button type="button" @click="searchSessions">Retry</button></p>
        <p id="palette-status" class="palette-status" role="status" :data-error="statusError || undefined">{{ status }}</p>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.palette {
  position: fixed; z-index: 91; left: 50%; top: 12dvh; transform: translateX(-50%);
  display: flex; flex-direction: column; width: min(640px, calc(100vw - 24px)); max-height: min(560px, 76dvh);
  background: var(--popover); border: 1px solid var(--border); border-radius: var(--r); box-shadow: 0 24px 90px #0009; overflow: hidden;
}
.palette-search { display: flex; align-items: center; gap: 10px; padding: 0 14px; border-bottom: 1px solid var(--border); color: var(--muted-foreground); }
.palette-search input { flex: 1; min-width: 0; height: 48px; background: transparent; border: 0; outline: none; color: var(--foreground); font-size: 15px; }
.palette-kbd { font-family: var(--mono); font-size: 11px; padding: 2px 6px; border: 1px solid var(--border); border-radius: var(--r-sm); color: var(--faint); }
.palette-list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px; }
.palette-group + .palette-group { margin-top: 6px; }
.palette-group-name { padding: 6px 8px 4px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--faint); }
.palette-item { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 6px 8px; border-radius: var(--r-sm); cursor: pointer; color: var(--foreground); }
.palette-item[aria-selected="true"] { background: var(--acc-soft); }
.palette-item[aria-disabled="true"] { color: var(--faint); cursor: default; }
.palette-check { display: inline-flex; width: 14px; flex: none; color: var(--primary-text); }
.palette-label { flex: none; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.palette-hint { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--muted-foreground); }
.palette-state { margin-left: auto; flex: none; font-family: var(--mono); font-size: 11px; padding: 1px 6px; border-radius: var(--r-sm); border: 1px solid var(--border); color: var(--muted-foreground); }
.palette-state[data-state="On"] { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--border)); }
.palette-empty { padding: 18px 8px; text-align: center; color: var(--muted-foreground); font-size: 13px; }
.palette-status { margin: 0; padding: 8px 14px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted-foreground); }
.palette-status:empty { display: none; }
.palette-status[data-error] { color: var(--destructive); }
@media (max-width: 760px) { .palette { top: calc(8px + env(safe-area-inset-top)); max-height: calc(var(--viewport-height, 100dvh) - 16px - env(safe-area-inset-top)); } .palette-label { max-width: 75%; } }
</style>
