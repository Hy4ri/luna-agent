<script setup lang="ts">
import { computed, ref, watch, nextTick, inject } from "vue";
import { Pin, PinOff, Search, Brain, Eye, Check, ArrowUp, ArrowDown, ChevronRight } from "@lucide/vue";
import { models, modelKey, togglePin, movePin } from "@/stores/models";
import type { ModelInfo } from "@/lib/types";

const injectedChoices = inject("settingsModelChoices", null as unknown as { value: string; label: string }[] | null);
// Settings provides draft custom-provider models that are not yet in /v1/models. Merge them in.
const injectedChoicesRef = computed(() => {
  const v: any = injectedChoices;
  if (Array.isArray(v)) return v as { value: string; label: string }[];
  if (v && typeof v === "object" && "value" in v && Array.isArray((v as any).value)) return (v as any).value as { value: string; label: string }[];
  return [] as { value: string; label: string }[];
});
const effectiveModels = computed<ModelInfo[]>(() => {
  const base = models.list.slice();
  const choices = injectedChoicesRef.value;
  if (!choices.length) return base;
  const seen = new Set(base.map(m => modelKey(m)));
  for (const c of choices) {
    if (!c?.value || seen.has(c.value)) continue;
    const slash = c.value.indexOf("/");
    if (slash < 1) continue;
    const provider = c.value.slice(0, slash);
    const id = c.value.slice(slash + 1);
    if (!provider || !id) continue;
    const labelName = c.label?.includes(" · ") ? c.label.split(" · ").pop()!.trim() : id;
    base.push({ provider, id, name: labelName || id } as ModelInfo);
    seen.add(c.value);
  }
  return base;
});

const props = withDefaults(defineProps<{
  value?: string;
  placeholder?: string;
  emptyLabel?: string;
  autofocus?: boolean;
  searchTarget?: HTMLElement;
  searchVisible?: boolean;
  compactPicker?: boolean;
  loading?: boolean;
  emptyHint?: string;
}>(), {
  placeholder: "Search models…",
  emptyLabel: "Use default",
  autofocus: false,
  searchVisible: true,
  compactPicker: false,
  loading: false,
  emptyHint: "",
});

const emit = defineEmits<{
  select: [key: string, model: ModelInfo | null];
  change: [value: string | undefined];
  close: [];
}>();

const editingPins = ref(false);
const query = ref("");
const openProviders = ref(new Set<string>());
const activeIndex = ref(0);
const searchRef = ref<HTMLInputElement | null>(null);
const listRef = ref<HTMLElement | null>(null);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return effectiveModels.value.filter(m => !q || `${m.provider}/${m.id} ${m.name || ""}`.toLowerCase().includes(q));
});
const providerGroups = computed(() => {
  const searching = !!query.value.trim();
  const groups = new Map<string, ModelInfo[]>();
  for (const m of filtered.value) {
    if (!searching && models.pins.includes(modelKey(m))) continue;
    const entries = groups.get(m.provider) || [];
    entries.push(m);
    groups.set(m.provider, entries);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([provider, entries]) => ({
    provider, models: entries, open: searching || openProviders.value.has(provider),
  }));
});
function toggleProvider(provider: string) {
  if (query.value.trim()) return;
  const next = new Set(openProviders.value);
  if (next.has(provider)) next.delete(provider); else next.add(provider);
  openProviders.value = next;
}

const pinnedModels = computed(() => {
  if (query.value.trim()) return [];
  return models.pins
    .map(key => {
      const [provider, ...rest] = key.split("/");
      const id = rest.join("/");
      const found = effectiveModels.value.find(m => m.provider === provider && m.id === id);
      return { key, model: found as ModelInfo | undefined, provider, id };
    })
    .filter(x => !!x.model);
});

type ListItem = { kind: "provider"; key: string; provider: string; count: number; open: boolean }
  | { kind: "model"; key: string; model: ModelInfo; pinned: boolean; pinIndex: number; index: number };
const listItems = computed<ListItem[]>(() => {
  const items: ListItem[] = [];
  let index = 0;
  pinnedModels.value.forEach((entry, pinIndex) => {
    if (entry.model) items.push({ kind: "model", key: entry.key, model: entry.model, pinned: true, pinIndex, index: index++ });
  });
  for (const group of providerGroups.value) {
    items.push({ kind: "provider", key: `provider:${group.provider}`, provider: group.provider, count: group.models.length, open: group.open });
    if (group.open) for (const model of group.models) {
      items.push({ kind: "model", key: modelKey(model), model, pinned: false, pinIndex: -1, index: index++ });
    }
  }
  return items;
});
const visibleModels = computed(() => listItems.value.flatMap(item => item.kind === "model" ? [item.model] : []));

function isSelected(m: ModelInfo) {
  return modelKey(m) === props.value;
}
function isPinned(key: string) {
  return models.pins.includes(key);
}
function displayName(m: ModelInfo) {
  return m.name || m.id;
}
function vision(m: ModelInfo) {
  const input = (m as any).input as string[] | undefined;
  return Array.isArray(input) && input.includes("image");
}
function reasoning(m: ModelInfo) {
  return !!(m as any).reasoning;
}

function selectKey(key: string) {
  const [provider, ...rest] = key.split("/");
  const id = rest.join("/");
  const model = effectiveModels.value.find(m => m.provider === provider && m.id === id) || null;
  if (!model && key) {
    // allow selecting unknown pinned key as minimal ModelInfo
    const fallback: ModelInfo = { provider, id, name: id };
    emit("select", key, fallback);
    emit("change", key);
    return;
  }
  emit("select", key, model);
  emit("change", key || undefined);
}
function selectModel(m: ModelInfo) {
  selectKey(modelKey(m));
}

function handleTogglePin(key: string, e: Event) {
  e.stopPropagation();
  togglePin(key);
}

function onKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing) return;
  const target = e.target as HTMLElement;
  if (e.key === "Escape") {
    e.preventDefault(); e.stopPropagation();
    if (query.value.trim()) { query.value = ""; focusSearch(); }
    else emit("close");
    return;
  }
  // Pin/edit buttons retain native activation and do not move the model cursor.
  if (target.closest(".ms-pin, .ms-edit")) return;
  const row = target.closest<HTMLButtonElement>(".ms-row, .ms-provider");
  const searching = target === searchRef.value;
  if (!row && !searching) return;
  if (searching && e.key === "Enter") {
    e.preventDefault();
    const model = visibleModels.value[activeIndex.value];
    if (model) selectModel(model);
    return;
  }
  // Focused rows use their own native Enter/Space click, never a stale active index.
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  if (searching && (e.key === "Home" || e.key === "End")) return;
  const rows = [...(listRef.value?.querySelectorAll<HTMLButtonElement>(".ms-row, .ms-provider") ?? [])]
    .filter(button => !button.disabled && button.getAttribute("aria-disabled") !== "true");
  if (!rows.length) return;
  e.preventDefault();
  const index = row ? rows.indexOf(row) : -1;
  const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1
    : index < 0 ? (e.key === "ArrowDown" ? 0 : rows.length - 1)
    : Math.max(0, Math.min(rows.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)));
  rows[next]?.focus();
  rows[next]?.scrollIntoView({ block: "nearest" });
}

watch(() => props.searchVisible, visible => { if (!visible) query.value = ""; });

watch(query, () => { activeIndex.value = 0; });
watch(visibleModels, (list) => {
  if (activeIndex.value >= list.length) activeIndex.value = Math.max(0, list.length - 1);
});

function focusSearch() {
  void nextTick(() => searchRef.value?.focus());
}

/** Expand the selected model's provider group and scroll it into view. */
function revealSelected() {
  const key = props.value;
  if (!key) return;
  const [provider] = key.split("/");
  if (provider && !query.value.trim()) {
    const next = new Set(openProviders.value);
    next.add(provider);
    openProviders.value = next;
  }
  void nextTick(() => {
    listRef.value?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  });
}
watch(() => props.value, () => revealSelected());
defineExpose({ focusSearch, revealSelected });
</script>

<template>
  <div class="model-selector" :class="{ 'ms-compact-picker': compactPicker }" @keydown="onKeydown">
    <Teleport :to="searchTarget || 'body'" :disabled="!searchTarget">
    <div v-if="searchVisible" class="ms-search" @keydown.stop="onKeydown">
      <Search :size="14" class="ms-search-icon" aria-hidden="true" />
      <input
        ref="searchRef"
        v-model="query"
        type="search"
        :placeholder="placeholder"
        aria-label="Search models"
        autocomplete="off"
        spellcheck="false"
      />
      <span v-if="query" class="ms-count">{{ filtered.length }}</span>
    </div>
    </Teleport>

    <div ref="listRef" class="ms-list" role="group" aria-label="Models">

      <button
        v-if="emptyLabel"
        type="button"
        class="ms-row"

        :data-active="activeIndex === -1 ? 'true' : undefined"
        :data-selected="!value ? 'true' : undefined"
        :aria-pressed="!value"
        @click="emit('select', '', null); emit('change', undefined)"
        @mouseenter="activeIndex = -1"
        @focus="activeIndex = -1"
      >
        <span class="ms-row-main"><span class="ms-name ms-muted">{{ emptyLabel }}</span></span>
        <Check v-if="!value" :size="14" class="ms-selected" aria-hidden="true" />
      </button>

      <template v-for="section in ['pinned', 'providers'] as const" :key="section">
      <div v-if="section === 'pinned' && pinnedModels.length" class="ms-section-head">
        <span class="ms-section-label">Pinned</span>
        <button type="button" class="ms-edit" :aria-pressed="editingPins" @click="editingPins = !editingPins">{{ editingPins ? "Done" : "Edit" }}</button>
      </div>
      <div v-if="section === 'providers' && pinnedModels.length && providerGroups.length" class="ms-divider" role="separator" aria-label="Other models"></div>
      <div v-if="section === 'pinned' ? pinnedModels.length : providerGroups.length" :class="section === 'pinned' ? 'ms-pinned-scroll' : 'ms-provider-scroll'">
      <template v-for="item in listItems.filter(item => section === 'pinned' ? item.kind === 'model' && item.pinned : item.kind === 'provider' || !item.pinned)" :key="item.key">
        <template v-if="item.kind === 'provider'">
          <button type="button" class="ms-provider" :aria-expanded="item.open" :aria-disabled="!!query.trim()" :tabindex="query.trim() ? -1 : 0" @click="toggleProvider(item.provider)">
            <ChevronRight :size="14" class="ms-provider-chevron" :class="{ 'is-open': item.open }" aria-hidden="true" />
            <span class="ms-provider-name">{{ item.provider }}</span>
            <span class="ms-provider-count">{{ item.count }}</span>
          </button>
        </template>
        <template v-else>
              <div class="ms-entry" :class="{ 'ms-entry-pinned': item.pinned }">
            <button
              type="button"
              class="ms-row"
              :data-model-index="item.index"
              :data-active="activeIndex === item.index ? 'true' : undefined"
              :data-selected="isSelected(item.model) ? 'true' : undefined"
              :aria-pressed="isSelected(item.model)"
              @click="selectModel(item.model)"
              @mouseenter="activeIndex = item.index"
              @focus="activeIndex = item.index"
      >
              <span class="ms-row-main">
          <span class="ms-name">{{ displayName(item.model) }}</span>
          <span class="ms-sub">{{ item.pinned ? item.model.provider : `${item.model.provider} · ${item.model.id}` }}</span>
              </span>
              <span v-if="isSelected(item.model)" class="ms-current">Current</span>
              <span class="ms-badges">
          <span v-if="reasoning(item.model)" class="ms-badge" role="img" aria-label="Supports reasoning" title="Supports reasoning"><Brain :size="11" aria-hidden="true" /><span class="ms-sr-only">Supports reasoning</span></span>
          <span v-if="vision(item.model)" class="ms-badge" role="img" aria-label="Vision capable" title="Vision capable"><Eye :size="11" aria-hidden="true" /><span class="ms-sr-only">Vision capable</span></span>
              </span>
              <Check v-if="isSelected(item.model)" :size="14" class="ms-selected" aria-hidden="true" />
            </button>
            <div v-if="editingPins && item.pinned" class="ms-pin-actions">
              <button type="button" class="ms-pin" :disabled="item.pinIndex === 0" :aria-label="'Move ' + displayName(item.model) + ' up'" @click="movePin(modelKey(item.model), -1)"><ArrowUp :size="14" /></button>
              <button type="button" class="ms-pin" :disabled="item.pinIndex === pinnedModels.length - 1" :aria-label="'Move ' + displayName(item.model) + ' down'" @click="movePin(modelKey(item.model), 1)"><ArrowDown :size="14" /></button>
              <button type="button" class="ms-pin" :aria-label="'Unpin ' + displayName(item.model)" @click="handleTogglePin(modelKey(item.model), $event)"><PinOff :size="14" /></button>
            </div>
            <button v-else-if="!isPinned(modelKey(item.model)) || !pinnedModels.length" type="button" class="ms-pin" :aria-label="(isPinned(modelKey(item.model)) ? 'Unpin ' : 'Pin ') + modelKey(item.model)" :aria-pressed="isPinned(modelKey(item.model))" @click="handleTogglePin(modelKey(item.model), $event)">
              <PinOff v-if="isPinned(modelKey(item.model))" :size="14" /><Pin v-else :size="14" />
            </button>
              </div>
        </template>
      </template>

      </div>
      </template>

      <p v-if="loading && !filtered.length" class="ms-empty" role="status">
        Loading models…
      </p>
      <p v-else-if="!filtered.length" class="ms-empty" role="status">
        <template v-if="query.trim()">No models match “{{ query }}”.</template>
        <template v-else>No models available.<span v-if="emptyHint"> {{ emptyHint }}</span></template>
      </p>
    </div>

    <div v-if="!compactPicker" class="ms-footer">
      <span class="ms-hint">{{ filtered.length }} models · ↑↓ navigate · Enter select · Esc clear</span>
    </div>
  </div>
</template>

<style scoped>
.model-selector { display: flex; flex-direction: column; gap: 10px; min-width: 0; min-height: 0; }
.ms-search { flex: 1; min-width: 0; position: relative; display: flex; align-items: center; }
.ms-search-icon { position: absolute; left: 10px; color: var(--muted-foreground); pointer-events: none; }
.ms-search input { width: 100%; min-height: 38px; padding: 8px 36px 8px 32px; border: 1px solid var(--input); border-radius: var(--radius); background: var(--background); color: var(--foreground); font-size: 14px; }
.ms-search input:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.ms-search input::placeholder { color: var(--muted-foreground); }
.ms-count { position: absolute; right: 10px; font-size: 11px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.ms-provider { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 40px; padding: 8px 10px; border: 0; border-radius: var(--radius); background: transparent; color: var(--foreground); text-align: left; cursor: pointer; }
.ms-provider:hover { background: var(--accent); }
.ms-provider:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.ms-provider-chevron { flex: none; color: var(--muted-foreground); transition: transform .15s ease; }
.ms-provider-chevron.is-open { transform: rotate(90deg); }
.ms-provider-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 12px; font-weight: 600; }
.ms-provider-count { color: var(--muted-foreground); font-size: 11px; font-variant-numeric: tabular-nums; }
.ms-entry:not(.ms-entry-pinned) { margin-left: 14px; border-left: 1px solid var(--border); padding-left: 3px; }
@media (prefers-reduced-motion: reduce) { .ms-provider-chevron { transition: none; } }
.ms-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 28px; padding: 0 10px; }
.ms-section-label { font-size: 11px; font-weight: 600; color: var(--muted-foreground); }
.ms-edit { min-height: 28px; padding: 0 6px; background: transparent; border: 0; color: var(--muted-foreground); font-size: 11px; cursor: pointer; }
.ms-edit:hover { color: var(--foreground); }
.ms-divider { flex: none; height: 1px; margin: 8px 0; background: color-mix(in srgb, var(--foreground) 22%, var(--border)); }
.ms-entry { display: flex; align-items: center; min-width: 0; }
.ms-entry > .ms-row { flex: 1; min-width: 0; width: auto; }
.ms-pin-actions { display: flex; flex: none; }
.ms-pin:disabled { opacity: .35; cursor: default; }
.ms-edit:focus-visible, .ms-pin:focus-visible, .ms-row:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.ms-list { display: flex; flex-direction: column; gap: 4px; max-height: 320px; overflow-y: auto; scrollbar-width: thin; padding: 2px; }
.ms-pinned-scroll, .ms-provider-scroll { display: flex; flex-direction: column; gap: 4px; }
.ms-compact-picker .ms-list { overflow: hidden; max-height: 620px; gap: 4px; }
.ms-compact-picker .ms-pinned-scroll { flex: 0 1 auto; min-height: 0; max-height: min(220px, 35dvh); overflow-y: auto; scrollbar-width: thin; }
.ms-compact-picker .ms-provider-scroll { flex: 1 1 auto; min-height: 72px; overflow-y: auto; scrollbar-width: thin; }
.ms-compact-picker .ms-section-head { flex: none; }
.ms-compact-picker .ms-divider { margin: 4px 0; }
.ms-row { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 44px; padding: 8px 10px; border: 1px solid transparent; border-radius: var(--radius); background: transparent; color: var(--foreground); text-align: left; cursor: pointer; }
.ms-row:hover, .ms-row[data-active="true"] { background: var(--accent); border-color: var(--border); }
.ms-row[data-selected="true"] { background: var(--acc-soft); border-color: color-mix(in srgb, var(--primary) 35%, var(--border)); }
.ms-row-main { flex: 1; min-width: 0; display: grid; gap: 1px; }
.ms-name { font-size: 13.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ms-name.ms-muted { color: var(--muted-foreground); font-weight: 450; }
.ms-sub { font-size: 11.5px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); }
.ms-badges { display: inline-flex; gap: 4px; flex: none; }
.ms-badge { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 999px; background: var(--secondary); border: 1px solid var(--border); color: var(--muted-foreground); }
.ms-entry-pinned > .ms-row { min-height: 44px; padding: 8px 10px; }
.ms-entry-pinned .ms-name { font-size: 12.5px; }
.ms-entry-pinned .ms-badge { width: 16px; height: 16px; border: 0; background: transparent; }
.ms-entry-pinned .ms-pin { height: 44px; }
.ms-current { flex: none; font-size: 10.5px; font-weight: 600; color: var(--primary-text); background: var(--acc-soft); border: 1px solid color-mix(in srgb, var(--primary) 35%, var(--border)); border-radius: 999px; padding: 2px 8px; }
.ms-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.ms-selected { flex: none; color: var(--primary-text); }
.ms-pin { flex: none; display: grid; place-items: center; width: 44px; height: 44px; border: 0; background: transparent; cursor: pointer; border-radius: var(--radius); color: var(--muted-foreground); }
.ms-pin:hover { background: var(--secondary); color: var(--foreground); }
.ms-pin[data-pinned="true"] { color: var(--primary-text); }
.ms-empty { padding: 16px 8px; text-align: center; font-size: 13px; color: var(--muted-foreground); }
.ms-footer { display: flex; justify-content: space-between; border-top: 1px solid var(--border); padding-top: 8px; }
.ms-hint { font-size: 11px; color: var(--muted-foreground); }
@media (max-width: 760px) {
  .ms-search input { min-height: 44px; font-size: 16px; }
  .ms-row { min-height: 48px; }
  .ms-provider { min-height: 44px; }
  .ms-entry-pinned > .ms-row, .ms-entry-pinned .ms-pin { min-height: 44px; }
}
</style>
