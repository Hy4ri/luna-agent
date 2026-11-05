<script setup lang="ts">
import { computed, ref, watch, nextTick, inject, onMounted } from "vue";
import { Pin, PinOff, Search, Brain, Eye, Check, ArrowUp, ArrowDown, ChevronRight } from "@lucide/vue";
import { models, modelKey, togglePin, movePin } from "@/stores/models";
import { useVirtualList } from "@vueuse/core";
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
  error?: string;
  selecting?: boolean;
}>(), {
  placeholder: "Search models…",
  emptyLabel: "Use default",
  autofocus: false,
  searchVisible: true,
  compactPicker: false,
  loading: false,
  emptyHint: "",
  error: "",
  selecting: false,
});

const emit = defineEmits<{
  select: [key: string, model: ModelInfo | null];
  change: [value: string | undefined];
  close: [];
  retry: [];
}>();

const editingPins = ref(false);
const pinPending = ref(false);
const pinError = ref("");
const query = ref("");
const openProviders = ref(new Set<string>());
const activeIndex = ref(0);
const searchRef = ref<HTMLInputElement | null>(null);

const effectiveModelMap = computed(() => {
  const map = new Map<string, ModelInfo>();
  for (const m of effectiveModels.value) {
    map.set(modelKey(m), m);
  }
  return map;
});
const catalogKeys = computed(() => new Set(effectiveModelMap.value.keys()));

// Keep missing catalog entries visible so saved pins can still be removed.
const savedPins = computed(() => models.pins.map(key => {
  const model = effectiveModelMap.value.get(key) ?? (() => {
    const [provider, ...rest] = key.split("/");
    const id = rest.join("/");
    return { provider, id, name: id } as ModelInfo;
  })();
  return { key, model };
}));

type ModelSearchEntry = {
  model: ModelInfo;
  searchText: string;
};

const searchEntries = computed<ModelSearchEntry[]>(() => {
  const entries: ModelSearchEntry[] = [];
  const seen = new Set<string>();

  for (const m of effectiveModels.value) {
    const key = modelKey(m);
    seen.add(key);
    entries.push({
      model: m,
      searchText: `${m.provider}/${m.id} ${m.name || ""}`.toLowerCase(),
    });
  }

  for (const p of savedPins.value) {
    if (!seen.has(p.key)) {
      seen.add(p.key);
      const m = p.model;
      entries.push({
        model: m,
        searchText: `${m.provider}/${m.id} ${m.name || ""}`.toLowerCase(),
      });
    }
  }

  return entries;
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) {
    return searchEntries.value.map(e => e.model);
  }
  const result: ModelInfo[] = [];
  for (const e of searchEntries.value) {
    if (e.searchText.includes(q)) {
      result.push(e.model);
    }
  }
  return result;
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

const pinnedModels = computed(() => query.value.trim() ? [] : savedPins.value);

type ListItem = { kind: "provider"; key: string; provider: string; count: number; open: boolean }
  | { kind: "model"; key: string; model: ModelInfo; pinned: boolean; pinIndex: number; index: number }
  | { kind: "empty" | "section" | "divider"; key: string };
const listItems = computed<ListItem[]>(() => {
  const items: ListItem[] = [];
  let index = 0;
  if (props.emptyLabel) items.push({ kind: "empty", key: "__empty__" });
  if (pinnedModels.value.length) items.push({ kind: "section", key: "__pinned_head__" });
  pinnedModels.value.forEach((entry, pinIndex) => {
    if (entry.model) items.push({ kind: "model", key: entry.key, model: entry.model, pinned: true, pinIndex, index: index++ });
  });
  for (const group of providerGroups.value) {
    if (pinnedModels.value.length && items.length && items[items.length - 1]!.kind === "model" && pinnedModels.value.some(e => e.model)) items.push({ kind: "divider", key: `__divider__${group.provider}` });
    items.push({ kind: "provider", key: `provider:${group.provider}`, provider: group.provider, count: group.models.length, open: group.open });
    if (group.open) for (const model of group.models) {
      items.push({ kind: "model", key: modelKey(model), model, pinned: false, pinIndex: -1, index: index++ });
    }
  }
  return items;
});
/** True windowing over the flattened list (fixed row heights; wrapper
 *  reserves total height). Heights match the scoped CSS below. */
const { list: vListItems, containerProps: msContainerProps, wrapperProps: msWrapperProps } = useVirtualList(listItems, {
  itemHeight: (i: number) => {
    const k = listItems.value[i]?.kind;
    return k === "provider" ? 40 : k === "section" ? 28 : k === "divider" ? 9 : k === "empty" ? 36 : 38;
  },
  overscan: 12,
});
const listRef = msContainerProps.ref;
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
  if (props.selecting || !catalogKeys.value.has(key)) return;
  const model = effectiveModelMap.value.get(key) || null;
  if (!model && key) {
    // allow selecting unknown pinned key as minimal ModelInfo
    const [provider, ...rest] = key.split("/");
    const id = rest.join("/");
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

async function updatePin(key: string, direction?: -1 | 1) {
  if (pinPending.value) return;
  pinPending.value = true;
  pinError.value = "";
  try {
    const ok = await (direction ? movePin(key, direction) : togglePin(key));
    if (!ok) pinError.value = "Could not save pinned models. Try again.";
  } finally {
    pinPending.value = false;
  }
}

function scrollToRow(row: HTMLElement) {
  const list = listRef.value;
  if (!list) return;
  const box = list.getBoundingClientRect();
  const item = row.getBoundingClientRect();
  if (item.top < box.top) list.scrollTop += item.top - box.top;
  else if (item.bottom > box.bottom) list.scrollTop += item.bottom - box.bottom;
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
    if (activeIndex.value === -1 && props.emptyLabel && !props.selecting) {
      emit("select", "", null); emit("change", undefined);
      return;
    }
    const active = visibleModels.value[activeIndex.value];
    const model = active && catalogKeys.value.has(modelKey(active)) ? active : visibleModels.value.find(m => catalogKeys.value.has(modelKey(m)));
    if (model) selectModel(model);
    return;
  }
  // Focused rows use their own native Enter/Space click, never a stale active index.
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  if (searching && (e.key === "Home" || e.key === "End")) return;
  const rows = [...(listRef.value?.querySelectorAll<HTMLButtonElement>("button.ms-row, button.ms-provider") ?? [])]
    .filter(button => !button.disabled && button.getAttribute("aria-disabled") !== "true");
  if (!rows.length) return;
  e.preventDefault();
  const index = row ? rows.indexOf(row) : -1;
  const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1
    : index < 0 ? (e.key === "ArrowDown" ? 0 : rows.length - 1)
    : Math.max(0, Math.min(rows.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)));
  const nextRow = rows[next];
  if (nextRow) { nextRow.focus({ preventScroll: true }); scrollToRow(nextRow); }
  else if (listRef.value) listRef.value.scrollTop += e.key === "ArrowDown" ? 38 : -38;
}

watch(() => props.searchVisible, visible => { if (!visible) query.value = ""; });

watch(query, () => {
  activeIndex.value = 0;
  void nextTick(() => { if (listRef.value) listRef.value.scrollTop = 0; });
});
watch(visibleModels, (list) => {
  if (activeIndex.value >= list.length) activeIndex.value = Math.max(0, list.length - 1);
});

function focusSearch() {
  void nextTick(() => searchRef.value?.focus({ preventScroll: true }));
}

/** Expand the selected model's provider group and scroll it into view. */
function revealSelected() {
  const key = props.value;
  if (!key) return;
  const [provider] = key.split("/");
  if (provider && !query.value.trim() && !models.pins.includes(key)) {
    const next = new Set(openProviders.value);
    next.add(provider);
    openProviders.value = next;
  }
  void nextTick(() => {
    const row = listRef.value?.querySelector<HTMLElement>('[data-selected="true"]');
    if (row) scrollToRow(row);
  });
}
function prepareOpen() {
  query.value = "";
  editingPins.value = false;
  pinError.value = "";
  activeIndex.value = 0;
  void nextTick(() => {
    if (listRef.value) listRef.value.scrollTop = 0;
    revealSelected();
  });
}
watch(() => props.value, () => revealSelected());
onMounted(prepareOpen);
defineExpose({ focusSearch, revealSelected, prepareOpen });
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

    <p v-if="loading" class="ms-notice" role="status">{{ effectiveModels.length ? "Refreshing models…" : "Loading models…" }}</p>
    <div v-else-if="error" class="ms-notice ms-error" role="alert">
      <span>{{ error }}</span>
      <button type="button" class="ms-retry" @click="emit('retry')">Retry</button>
    </div>
    <p v-if="pinError" class="ms-notice ms-error" role="alert">{{ pinError }}</p>
    <p v-if="selecting" class="ms-notice" role="status">Changing model…</p>

    <div class="ms-list" role="group" aria-label="Models" :aria-busy="loading || selecting" v-bind="msContainerProps">
    <div v-bind="msWrapperProps" class="ms-wrapper">

      <template v-for="{ data: item } in vListItems" :key="item.key">
        <button
        v-if="item.kind === 'empty'"
        type="button"
        class="ms-row"
        :disabled="selecting"
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

        <div v-if="item.kind === 'section'" class="ms-section-head">
        <span class="ms-section-label">Pinned</span>
        <button type="button" class="ms-edit" :aria-pressed="editingPins" @click="editingPins = !editingPins">{{ editingPins ? "Done" : "Edit" }}</button>
      </div>
        <template v-if="item.kind === 'provider'">
          <component
            :is="query.trim() ? 'div' : 'button'"
            :type="query.trim() ? undefined : 'button'"
            class="ms-provider"
            :class="{ 'ms-provider-label': query.trim() }"
            :role="query.trim() ? 'heading' : undefined"
            :aria-level="query.trim() ? 4 : undefined"
            :aria-expanded="query.trim() ? undefined : item.open"
            @click="toggleProvider(item.provider)"
          >
            <ChevronRight v-if="!query.trim()" :size="14" class="ms-provider-chevron" :class="{ 'is-open': item.open }" aria-hidden="true" />
            <span class="ms-provider-name">{{ item.provider }}</span>
            <span class="ms-provider-count">{{ item.count }}</span>
          </component>
        </template>
        <template v-else-if="item.kind === 'model'">
              <div class="ms-entry" :class="{ 'ms-entry-pinned': item.pinned }">
            <button
              type="button"
              class="ms-row"
              :disabled="selecting || !catalogKeys.has(item.key)"
              :data-model-index="item.index"
              :data-active="activeIndex === item.index ? 'true' : undefined"
              :data-selected="isSelected(item.model) ? 'true' : undefined"
              :aria-pressed="isSelected(item.model)"
              :title="`${displayName(item.model)} · ${modelKey(item.model)}`"
              @click="selectModel(item.model)"
              @mouseenter="activeIndex = item.index"
              @focus="activeIndex = item.index"
      >
              <span class="ms-row-main">
          <span class="ms-name">{{ displayName(item.model) }}</span>
          <span class="ms-sub">{{ item.pinned ? item.model.provider : `${item.model.provider} · ${item.model.id}` }}<template v-if="!catalogKeys.has(item.key)"> · Unavailable</template></span>
              </span>
              <span v-if="isSelected(item.model)" class="ms-current">Current</span>
              <span class="ms-badges">
          <span v-if="reasoning(item.model)" class="ms-badge" role="img" aria-label="Supports reasoning" title="Supports reasoning"><Brain :size="11" aria-hidden="true" /><span class="ms-sr-only">Supports reasoning</span></span>
          <span v-if="vision(item.model)" class="ms-badge" role="img" aria-label="Vision capable" title="Vision capable"><Eye :size="11" aria-hidden="true" /><span class="ms-sr-only">Vision capable</span></span>
              </span>
              <Check v-if="isSelected(item.model)" :size="14" class="ms-selected" aria-hidden="true" />
            </button>
            <div v-if="editingPins && item.pinned" class="ms-pin-actions">
              <button type="button" class="ms-pin" :disabled="pinPending || item.pinIndex === 0" :aria-label="'Move ' + displayName(item.model) + ' up'" @click="updatePin(item.key, -1)"><ArrowUp :size="14" /></button>
              <button type="button" class="ms-pin" :disabled="pinPending || item.pinIndex === pinnedModels.length - 1" :aria-label="'Move ' + displayName(item.model) + ' down'" @click="updatePin(item.key, 1)"><ArrowDown :size="14" /></button>
              <button type="button" class="ms-pin" :disabled="pinPending" :aria-label="'Unpin ' + displayName(item.model)" @click="updatePin(item.key)"><PinOff :size="14" /></button>
            </div>
            <button v-else-if="query.trim() || !isPinned(item.key)" type="button" class="ms-pin" :disabled="pinPending" :aria-label="(isPinned(modelKey(item.model)) ? 'Unpin ' : 'Pin ') + modelKey(item.model)" :aria-pressed="isPinned(modelKey(item.model))" @click="updatePin(item.key)">
              <PinOff v-if="isPinned(modelKey(item.model))" :size="14" /><Pin v-else :size="14" />
            </button>
              </div>
        </template>
        <div v-else-if="item.kind === 'divider'" class="ms-divider" role="separator" aria-label="Other models"></div>
      </template>
    </div>

      <p v-if="!filtered.length && !loading && (!error || query.trim())" class="ms-empty" role="status">
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
.model-selector { flex: 1 1 auto; display: flex; flex-direction: column; gap: 10px; min-width: 0; min-height: 0; }
.ms-search { flex: none; min-width: 0; position: relative; display: flex; align-items: center; }
.ms-search-icon { position: absolute; left: 10px; color: var(--muted-foreground); pointer-events: none; }
.ms-search input { width: 100%; min-height: 38px; padding: 8px 36px 8px 32px; border: 1px solid var(--input); border-radius: var(--radius); background: var(--background); color: var(--foreground); font-size: 14px; }
.ms-search input:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.ms-search input::placeholder { color: var(--muted-foreground); }
.ms-count { position: absolute; right: 10px; font-size: 11px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
 .ms-provider { display: flex; align-items: center; gap: 8px; width: 100%; height: 40px; box-sizing: border-box; padding: 8px 10px; border: 0; border-radius: var(--radius); background: transparent; color: var(--foreground); text-align: left; cursor: pointer; }
.ms-provider:not(.ms-provider-label):hover { background: var(--accent); }
.ms-provider-label { cursor: default; }
.ms-provider:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.ms-provider-chevron { flex: none; color: var(--muted-foreground); transition: transform .15s ease; }
.ms-provider-chevron.is-open { transform: rotate(90deg); }
.ms-provider-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 12px; font-weight: 600; }
.ms-provider-count { color: var(--muted-foreground); font-size: 11px; font-variant-numeric: tabular-nums; }
.ms-entry:not(.ms-entry-pinned) { margin-left: 14px; border-left: 1px solid var(--border); padding-left: 3px; }
@media (max-width: 767px) { .ms-search input { font-size: 16px; } }
@media (prefers-reduced-motion: reduce) { .ms-provider-chevron { transition: none; } }
 .ms-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 28px; box-sizing: border-box; padding: 0 10px; }
.ms-section-label { font-size: 11px; font-weight: 600; color: var(--muted-foreground); }
.ms-edit { min-height: 28px; padding: 0 6px; background: transparent; border: 0; color: var(--muted-foreground); font-size: 11px; cursor: pointer; }
.ms-edit:hover { color: var(--foreground); }
 .ms-divider { flex: none; height: 1px; margin: 4px 0; background: color-mix(in srgb, var(--foreground) 22%, var(--border)); }
.ms-entry { display: flex; align-items: center; min-width: 0; }
.ms-entry > .ms-row { flex: 1; min-width: 0; width: auto; }
.ms-pin-actions { display: flex; flex: none; }
.ms-pin:disabled { opacity: .35; cursor: default; }
.ms-edit:focus-visible, .ms-pin:focus-visible, .ms-row:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
/* One scroll owner. Expanding providers must never shrink or clip pinned rows. */
.ms-list { flex: 1 1 auto; min-height: 0; max-height: 320px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; padding: 2px; overflow-anchor: none; }
.ms-wrapper { width: 100%; }
.ms-wrapper > * { margin-bottom: 2px; }
.ms-list > * { flex-shrink: 0; }
.ms-compact-picker .ms-list { max-height: none; }
.ms-compact-picker .ms-divider { margin: 4px 0; }
 .ms-row { display: flex; align-items: center; gap: 6px; width: 100%; height: 38px; box-sizing: border-box; padding: 3px 8px; border: 1px solid transparent; border-radius: var(--radius); background: transparent; color: var(--foreground); text-align: left; cursor: pointer; }
.ms-row:not(:disabled):hover, .ms-row[data-active="true"] { background: var(--accent); border-color: var(--border); }
.ms-row[data-selected="true"] { background: var(--acc-soft); border-color: color-mix(in srgb, var(--primary) 35%, var(--border)); }
.ms-row-main { flex: 1; min-width: 0; display: grid; gap: 0; line-height: 1.15; }
.ms-name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ms-name.ms-muted { color: var(--muted-foreground); font-weight: 450; }
.ms-sub { font-size: 11px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); }
.ms-badges { display: inline-flex; gap: 4px; flex: none; }
.ms-badge { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 999px; background: var(--secondary); border: 1px solid var(--border); color: var(--muted-foreground); }
.ms-entry-pinned > .ms-row { min-height: 36px; padding: 3px 8px; }
.ms-entry-pinned .ms-name { font-size: 12.5px; }
.ms-entry-pinned .ms-badge { width: 16px; height: 16px; border: 0; background: transparent; }
.ms-entry-pinned .ms-pin { height: 36px; }
.ms-current { flex: none; font-size: 10px; font-weight: 600; color: var(--primary-text); background: var(--acc-soft); border: 1px solid color-mix(in srgb, var(--primary) 35%, var(--border)); border-radius: 999px; padding: 1px 6px; }
.ms-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.ms-selected { flex: none; color: var(--primary-text); }
.ms-pin { flex: none; display: grid; place-items: center; width: 32px; height: 36px; border: 0; background: transparent; cursor: pointer; border-radius: var(--radius); color: var(--muted-foreground); }
.ms-pin:hover { background: var(--secondary); color: var(--foreground); }
.ms-pin[data-pinned="true"] { color: var(--primary-text); }
.ms-empty { padding: 16px 8px; text-align: center; font-size: 13px; color: var(--muted-foreground); }
.ms-footer { flex: none; display: flex; justify-content: space-between; border-top: 1px solid var(--border); padding-top: 8px; }
.ms-notice { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px; font-size: 12px; color: var(--muted-foreground); }
.ms-error { color: var(--destructive); }
.ms-retry { flex: none; min-height: 32px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--secondary); color: var(--foreground); cursor: pointer; }
.ms-retry:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.ms-row:disabled { opacity: .6; cursor: default; }
.ms-hint { font-size: 11px; color: var(--muted-foreground); }
@media (max-width: 760px) {
  .ms-search input { min-height: 44px; font-size: 16px; }
  .ms-row { min-height: 36px; }
  .ms-provider { min-height: 44px; }
  .ms-entry-pinned > .ms-row, .ms-entry-pinned .ms-pin { min-height: 36px; }
}
</style>
