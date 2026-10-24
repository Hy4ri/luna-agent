<script setup lang="ts">
import { computed, ref, watch, nextTick, inject } from "vue";
import { Pin, PinOff, Search, Brain, Eye, Check } from "@lucide/vue";
import { models, modelKey, togglePin } from "@/stores/models";
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
}>(), {
  placeholder: "Search models…",
  emptyLabel: "Use default",
  autofocus: false,
});

const emit = defineEmits<{
  select: [key: string, model: ModelInfo | null];
  change: [value: string | undefined];
}>();

const query = ref("");
const providerFilter = ref<string>("all");
const activeIndex = ref(0);
const searchRef = ref<HTMLInputElement | null>(null);
const listRef = ref<HTMLElement | null>(null);

const providers = computed(() => {
  const set = new Set(effectiveModels.value.map(m => m.provider));
  return [...set].sort((a, b) => a.localeCompare(b));
});

const filtered = computed<ModelInfo[]>(() => {
  let list = effectiveModels.value.slice();
  if (providerFilter.value !== "all") list = list.filter(m => m.provider === providerFilter.value);
  const q = query.value.trim().toLowerCase();
  if (q) {
    list = list.filter(m => {
      const hay = `${m.provider}/${m.id} ${m.name || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }
  // pinned first when not searching? keep stable order otherwise
  if (!q && providerFilter.value === "all") {
    const pinSet = new Set(models.pins);
    const pinned = list.filter(m => pinSet.has(modelKey(m)));
    const rest = list.filter(m => !pinSet.has(modelKey(m)));
    // keep pinned in pin order
    pinned.sort((a, b) => models.pins.indexOf(modelKey(a)) - models.pins.indexOf(modelKey(b)));
    return [...pinned, ...rest];
  }
  return list;
});

const pinnedModels = computed(() => {
  if (query.value.trim() || providerFilter.value !== "all") return [];
  return models.pins
    .map(key => {
      const [provider, ...rest] = key.split("/");
      const id = rest.join("/");
      const found = effectiveModels.value.find(m => m.provider === provider && m.id === id);
      return { key, model: found as ModelInfo | undefined, provider, id };
    })
    .filter(x => !!x.model);
});

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
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeIndex.value = Math.min(activeIndex.value + 1, filtered.value.length - 1);
    scrollActive();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeIndex.value = Math.max(activeIndex.value - 1, 0);
    scrollActive();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const m = filtered.value[activeIndex.value];
    if (m) selectModel(m);
  } else if (e.key === "Escape") {
    query.value = "";
    providerFilter.value = "all";
  }
}

function scrollActive() {
  void nextTick(() => {
    const el = listRef.value?.querySelector<HTMLElement>("[data-active='true']");
    el?.scrollIntoView({ block: "nearest" });
  });
}

watch([query, providerFilter], () => { activeIndex.value = 0; });
watch(filtered, (list) => {
  if (activeIndex.value >= list.length) activeIndex.value = Math.max(0, list.length - 1);
});

function focusSearch() {
  void nextTick(() => searchRef.value?.focus());
}
defineExpose({ focusSearch });
</script>

<template>
  <div class="model-selector" @keydown="onKeydown">
    <div class="ms-search">
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

    <div v-if="providers.length > 1" class="ms-chips" role="tablist" aria-label="Filter by provider">
      <button
        type="button"
        class="ms-chip"
        :data-active="providerFilter === 'all' ? 'true' : undefined"
        role="tab"
        :aria-selected="providerFilter === 'all'"
        @click="providerFilter = 'all'"
      >All <span class="ms-chip-count">{{ models.list.length }}</span></button>
      <button
        v-for="p in providers"
        :key="p"
        type="button"
        class="ms-chip"
        :data-active="providerFilter === p ? 'true' : undefined"
        role="tab"
        :aria-selected="providerFilter === p"
        @click="providerFilter = p"
      >{{ p }}<span class="ms-chip-count">{{ models.list.filter(m=>m.provider===p).length }}</span></button>
    </div>

    <div v-if="pinnedModels.length" class="ms-pinned" aria-label="Pinned models">
      <div class="ms-section-label">Pinned</div>
      <div class="ms-pinned-row">
        <button
          v-for="entry in pinnedModels"
          :key="entry.key"
          type="button"
          class="ms-pinned-chip"
          :data-selected="value === entry.key ? 'true' : undefined"
          :title="entry.key"
          @click="selectKey(entry.key)"
        >
          <span class="ms-pinned-name">{{ entry.model?.name || entry.id }}</span>
          <small>{{ entry.provider }}</small>
          <span v-if="value === entry.key" class="ms-check"><Check :size="12" /></span>
        </button>
      </div>
    </div>

    <div ref="listRef" class="ms-list" role="listbox" :aria-label="emptyLabel">
      <button
        v-if="emptyLabel"
        type="button"
        class="ms-row"
        role="option"
        :data-active="activeIndex === -1 ? 'true' : undefined"
        :data-selected="!value ? 'true' : undefined"
        :aria-selected="!value"
        @click="emit('select', '', null); emit('change', undefined)"
        @mouseenter="activeIndex = -1"
      >
        <span class="ms-row-main"><span class="ms-name ms-muted">{{ emptyLabel }}</span></span>
        <Check v-if="!value" :size="14" class="ms-selected" aria-hidden="true" />
      </button>

      <button
        v-for="(m, i) in filtered"
        :key="modelKey(m)"
        type="button"
        class="ms-row"
        role="option"
        :data-active="activeIndex === i ? 'true' : undefined"
        :data-selected="isSelected(m) ? 'true' : undefined"
        :aria-selected="isSelected(m)"
        @click="selectModel(m)"
        @mouseenter="activeIndex = i"
      >
        <span class="ms-row-main">
          <span class="ms-name">{{ displayName(m) }}</span>
          <span class="ms-sub">{{ m.provider }} · {{ m.id }}</span>
        </span>
        <span class="ms-badges" aria-hidden="true">
          <span v-if="reasoning(m)" class="ms-badge" title="Supports reasoning"><Brain :size="11" /> </span>
          <span v-if="vision(m)" class="ms-badge" title="Vision capable"><Eye :size="11" /></span>
        </span>
        <Check v-if="isSelected(m)" :size="14" class="ms-selected" aria-hidden="true" />
        <span
          role="button"
          :aria-label="(isPinned(modelKey(m)) ? 'Unpin ' : 'Pin ') + modelKey(m)"
          class="ms-pin"
          :data-pinned="isPinned(modelKey(m)) ? 'true' : undefined"
          @click="handleTogglePin(modelKey(m), $event)"
        >
          <Pin v-if="!isPinned(modelKey(m))" :size="13" />
          <PinOff v-else :size="13" />
        </span>
      </button>

      <p v-if="!filtered.length" class="ms-empty" role="status">
        No models match “{{ query }}”{{ providerFilter !== 'all' ? ' in ' + providerFilter : '' }}.
      </p>
    </div>

    <div class="ms-footer">
      <span class="ms-hint">{{ filtered.length }} models · ↑↓ navigate · Enter select · Esc clear</span>
    </div>
  </div>
</template>

<style scoped>
.model-selector { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ms-search { position: relative; display: flex; align-items: center; }
.ms-search-icon { position: absolute; left: 10px; color: var(--muted-foreground); pointer-events: none; }
.ms-search input { width: 100%; min-height: 38px; padding: 8px 36px 8px 32px; border: 1px solid var(--input); border-radius: var(--radius); background: var(--background); color: var(--foreground); font-size: 14px; }
.ms-search input:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.ms-search input::placeholder { color: var(--muted-foreground); }
.ms-count { position: absolute; right: 10px; font-size: 11px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.ms-chips { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: thin; padding-bottom: 2px; }
.ms-chip { flex: none; display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 999px; background: var(--background); color: var(--muted-foreground); font-size: 12.5px; white-space: nowrap; cursor: pointer; }
.ms-chip[data-active="true"] { background: var(--acc-soft); border-color: color-mix(in srgb, var(--primary) 35%, var(--border)); color: var(--primary-text); font-weight: 600; }
.ms-chip-count { font-size: 11px; opacity: .7; font-variant-numeric: tabular-nums; }
.ms-pinned { display: grid; gap: 6px; padding: 8px; border: 1px solid var(--border); border-radius: var(--radius); background: color-mix(in srgb, var(--card) 85%, transparent); }
.ms-section-label { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted-foreground); }
.ms-pinned-row { display: flex; gap: 6px; flex-wrap: wrap; }
.ms-pinned-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 999px; background: var(--background); color: var(--foreground); font-size: 12.5px; cursor: pointer; max-width: 100%; }
.ms-pinned-chip[data-selected="true"] { border-color: var(--primary); background: var(--acc-soft); color: var(--primary-text); }
.ms-pinned-name { font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 14ch; }
.ms-pinned-chip small { color: var(--muted-foreground); font-size: 11px; }
.ms-check { display: grid; place-items: center; color: var(--primary-text); }
.ms-list { display: flex; flex-direction: column; gap: 4px; max-height: 320px; overflow-y: auto; scrollbar-width: thin; padding: 2px; }
.ms-row { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 44px; padding: 8px 10px; border: 1px solid transparent; border-radius: var(--radius); background: transparent; color: var(--foreground); text-align: left; cursor: pointer; }
.ms-row:hover, .ms-row[data-active="true"] { background: var(--accent); border-color: var(--border); }
.ms-row[data-selected="true"] { background: var(--acc-soft); border-color: color-mix(in srgb, var(--primary) 35%, var(--border)); }
.ms-row-main { flex: 1; min-width: 0; display: grid; gap: 1px; }
.ms-name { font-size: 13.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ms-name.ms-muted { color: var(--muted-foreground); font-weight: 450; }
.ms-sub { font-size: 11.5px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); }
.ms-badges { display: inline-flex; gap: 4px; flex: none; }
.ms-badge { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 999px; background: var(--secondary); border: 1px solid var(--border); color: var(--muted-foreground); }
.ms-selected { flex: none; color: var(--primary-text); }
.ms-pin { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: var(--radius); color: var(--muted-foreground); }
.ms-pin:hover { background: var(--secondary); color: var(--foreground); }
.ms-pin[data-pinned="true"] { color: var(--primary-text); }
.ms-empty { padding: 16px 8px; text-align: center; font-size: 13px; color: var(--muted-foreground); }
.ms-footer { display: flex; justify-content: space-between; border-top: 1px solid var(--border); padding-top: 8px; }
.ms-hint { font-size: 11px; color: var(--muted-foreground); }
@media (max-width: 760px) {
  .ms-search input { min-height: 44px; font-size: 16px; }
  .ms-row { min-height: 48px; }
}
</style>
