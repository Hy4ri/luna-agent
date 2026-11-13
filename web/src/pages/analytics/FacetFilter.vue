<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ChevronDown } from "@lucide/vue";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface FacetOption {
  value: string;
  label: string;
}

const props = defineProps<{
  label: string;
  singular: string;
  options: FacetOption[];
  selected: string[];
  disabled?: boolean;
  disabledReason?: string;
}>();

const emit = defineEmits<{
  (e: "update", values: string[]): void;
}>();

const open = ref(false);
const query = ref("");
const searchInputRef = ref<HTMLInputElement | null>(null);
const openSelectedSnapshot = ref<Set<string>>(new Set());

watch(open, async (isOpen) => {
  if (isOpen) {
    openSelectedSnapshot.value = new Set(props.selected);
    query.value = "";
    if (props.options.length > 7) {
      await nextTick();
      searchInputRef.value?.focus();
    }
  }
});

const selectedSet = computed(() => new Set(props.selected));

const triggerText = computed(() => {
  const count = props.selected.length;
  if (count === 0) return props.label;
  if (count === 1) {
    const val = props.selected[0];
    const opt = props.options.find((o) => o.value === val);
    return `${props.singular}: ${opt ? opt.label : val}`;
  }
  return `${props.label}: ${count}`;
});

const sortedOptions = computed(() => {
  const snap = openSelectedSnapshot.value;
  return [...props.options].sort((a, b) => {
    const aSel = snap.has(a.value) ? 0 : 1;
    const bSel = snap.has(b.value) ? 0 : 1;
    return aSel - bSel;
  });
});

const filteredOptions = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return sortedOptions.value;
  return sortedOptions.value.filter(
    (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
  );
});

function toggle(value: string) {
  if (selectedSet.value.has(value)) {
    emit(
      "update",
      props.selected.filter((v) => v !== value),
    );
  } else {
    emit("update", [...props.selected, value]);
  }
}

function clear() {
  if (props.selected.length > 0) {
    emit("update", []);
  }
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button
        type="button"
        :disabled="disabled"
        :title="disabled ? disabledReason : undefined"
        :class="[
          'inline-flex h-8 max-[760px]:min-h-11 items-center gap-1.5 rounded-[var(--radius)] border bg-secondary px-2.5 text-xs transition-colors',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]',
          selected.length > 0
            ? 'border-[var(--primary-text)]/60 text-foreground'
            : 'border-border text-muted-foreground hover:text-foreground',
          disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-accent',
        ]"
      >
        <span class="max-w-[180px] truncate">{{ triggerText }}</span>
        <ChevronDown class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
    </PopoverTrigger>

    <PopoverContent align="start" class="w-72 p-0">
      <div class="flex items-center justify-between border-b border-border px-3 py-2">
        <span class="text-xs font-medium text-foreground">{{ label }}</span>
        <button
          type="button"
          :disabled="selected.length === 0"
          class="rounded-[var(--radius)] px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-40"
          @click="clear"
        >
          Clear
        </button>
      </div>

      <div v-if="options.length > 7" class="border-b border-border p-2">
        <input
          ref="searchInputRef"
          v-model="query"
          type="search"
          :placeholder="`Filter ${label.toLowerCase()}…`"
          class="h-8 w-full rounded-[var(--radius)] border border-input bg-background px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
        />
      </div>

      <div class="max-h-64 overflow-y-auto py-1">
        <div
          v-if="options.length === 0"
          class="px-3 py-4 text-center text-xs text-muted-foreground"
        >
          No {{ label.toLowerCase() }} recorded yet.
        </div>
        <div
          v-else-if="filteredOptions.length === 0"
          class="px-3 py-4 text-center text-xs text-muted-foreground"
        >
          No match.
        </div>
        <label
          v-for="opt in filteredOptions"
          v-else
          :key="opt.value"
          class="flex min-h-8 cursor-pointer items-center gap-2 px-3 py-1 text-xs text-foreground hover:bg-accent"
        >
          <input
            type="checkbox"
            :checked="selectedSet.has(opt.value)"
            class="h-3.5 w-3.5 shrink-0 rounded-[var(--radius)] accent-[var(--primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
            @change="toggle(opt.value)"
          />
          <span class="truncate" :title="opt.label">{{ opt.label }}</span>
        </label>
      </div>

      <div class="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        {{ selected.length }} selected
      </div>
    </PopoverContent>
  </Popover>
</template>
