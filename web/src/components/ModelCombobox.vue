<script setup lang="ts">
import { computed, inject, ref, watch, nextTick } from "vue";
import { ChevronsUpDown } from "@lucide/vue";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useModelRefresh } from "@/lib/use-model-refresh";
import ModelSelector from "@/components/ModelSelector.vue";
import ModelRefreshButton from "@/components/ModelRefreshButton.vue";
import { models, modelKey } from "@/stores/models";
import { cn } from "@/lib/utils";

const props = withDefaults(defineProps<{
  modelValue?: string;
  placeholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  ariaLabel?: string;
  dataSetting?: string;
  contentClass?: string;
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
const selectorRef = ref<InstanceType<typeof ModelSelector> | null>(null);
const { loading, errorText, retry, refreshAll, begin, cancel, markInteracted } = useModelRefresh(selectorRef, () => open.value);

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
  const listed = models.list.find(m => modelKey(m) === props.modelValue);
  if (listed) return `${listed.provider} · ${listed.name || listed.id}`;
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
    begin();
    void nextTick(() => { selectorRef.value?.prepareOpen(); selectorRef.value?.focusSearch(); });
  } else {
    cancel();
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
:class="cn('w-[min(440px,calc(100vw-16px))] p-3 max-h-[min(520px,70dvh,var(--reka-popover-content-available-height))] overflow-hidden flex flex-col', contentClass)"
      @pointerdown.capture="markInteracted()"
      @keydown.capture="markInteracted()"
      @wheel.passive="markInteracted()"
    >
      <div class="combobox-head">
        <ModelRefreshButton :loading="loading" @refresh="refreshAll" />
      </div>
      <ModelSelector
        ref="selectorRef"
        :value="modelValue || ''"
        :loading="loading"
        :error="errorText"
        :placeholder="placeholder"
        :empty-label="emptyLabel"
        @retry="retry"
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
.combobox-head { flex: none; display: flex; justify-content: flex-end; margin-bottom: 8px; }
.combobox-chevron { flex: none; color: var(--muted-foreground); }
.input { width: 100%; min-width: 0; min-height: 40px; padding: 8px 12px; border: 1px solid var(--input); border-radius: var(--radius); background: var(--background); color: var(--foreground); font-size: 14px; }
.input:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
</style>
