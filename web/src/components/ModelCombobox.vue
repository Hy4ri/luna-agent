<script setup lang="ts">
import { computed, inject, ref, watch, nextTick } from "vue";
import { ChevronsUpDown } from "@lucide/vue";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { loadModels, models } from "@/stores/models";
import ModelSelector from "@/components/ModelSelector.vue";

const props = withDefaults(defineProps<{
  modelValue?: string;
  placeholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  ariaLabel?: string;
  dataSetting?: string;
}>(), {
  modelValue: undefined,
  placeholder: "Search models…",
  emptyLabel: "Use default",
  disabled: false,
});

const emit = defineEmits<{
  "update:modelValue": [value: string | undefined];
  change: [value: string | undefined];
  select: [key: string];
}>();

const open = ref(false);
const loading = ref(false);
const loadError = ref(false);
let refreshGeneration = 0;
let interacted = false;
async function refreshModels() {
  const request = ++refreshGeneration;
  loading.value = true;
  loadError.value = false;
  try {
    const ok = await loadModels({ force: true });
    if (request === refreshGeneration) loadError.value = !ok;
  } finally {
    if (request === refreshGeneration) {
      loading.value = false;
      if (open.value && !interacted) selectorRef.value?.revealSelected();
    }
  }
}
const selectorRef = ref<InstanceType<typeof ModelSelector> | null>(null);

// label: try to resolve via injected choices + fallback to raw value
const injected = inject("settingsModelChoices", null as any);
const choices = computed<{ value: string; label: string }[]>(() => {
  const v: any = injected;
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object" && "value" in v && Array.isArray((v as any).value)) return (v as any).value;
  return [];
});
const displayLabel = computed(() => {
  if (!props.modelValue) return props.emptyLabel;
  const found = choices.value.find(c => c.value === props.modelValue);
  if (found) return found.label;
  // fallback: provider · id
  const slash = props.modelValue.indexOf("/");
  if (slash > 0) {
    const provider = props.modelValue.slice(0, slash);
    const id = props.modelValue.slice(slash + 1);
    return `${provider} · ${id}`;
  }
  return props.modelValue;
});

function onSelect(key: string) {
  const next = key || undefined;
  emit("update:modelValue", next);
  emit("change", next);
  emit("select", key);
  open.value = false;
}

watch(open, (v) => {
  if (v) {
    interacted = false;
    void refreshModels();
    void nextTick(() => { selectorRef.value?.prepareOpen(); selectorRef.value?.focusSearch(); });
  } else {
    refreshGeneration++;
    loading.value = false;
  }
});
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button
        type="button"
        class="input combobox-trigger"
        :disabled="disabled"
        :title="displayLabel"
        :aria-label="ariaLabel ? `${ariaLabel}: ${displayLabel}` : `Choose model: ${displayLabel}`"
        :data-setting="dataSetting"
        :data-empty="!modelValue ? 'true' : undefined"
      >
        <span class="combobox-label" :data-empty="!modelValue ? 'true' : undefined">{{ displayLabel }}</span>
        <ChevronsUpDown :size="16" class="combobox-chevron" aria-hidden="true" />
      </button>
    </PopoverTrigger>
    <PopoverContent
      align="start" side="bottom" :side-offset="6"
      class="w-[min(440px,calc(100vw-16px))] p-3 max-h-[min(520px,70dvh,var(--reka-popover-content-available-height))] overflow-hidden flex flex-col"
      @pointerdown.capture="interacted = true"
      @keydown.capture="interacted = true"
      @wheel.passive="interacted = true"
    >
      <ModelSelector
        ref="selectorRef"
        :value="modelValue || ''"
        :loading="loading"
        :error="loadError ? (models.list.length ? 'Could not refresh models. Showing saved models.' : 'Could not load models.') : ''"
        :placeholder="placeholder"
        :empty-label="emptyLabel"
        @retry="refreshModels"
        @select="onSelect as any"
        @close="open = false"
      />
    </PopoverContent>
  </Popover>
</template>

<style scoped>
.combobox-trigger { display: flex; align-items: center; justify-content: space-between; gap: 8px; text-align: left; cursor: pointer; }
.combobox-trigger:disabled { opacity: .6; cursor: not-allowed; }
.combobox-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.combobox-label[data-empty="true"] { color: var(--muted-foreground); }
.combobox-chevron { flex: none; color: var(--muted-foreground); }
.input { width: 100%; min-width: 0; min-height: 40px; padding: 8px 12px; border: 1px solid var(--input); border-radius: var(--radius); background: var(--background); color: var(--foreground); font-size: 14px; }
.input:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
</style>
