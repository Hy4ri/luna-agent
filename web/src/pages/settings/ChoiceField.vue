<script setup lang="ts">
import { computed, ref, useAttrs } from 'vue'
defineOptions({ inheritAttrs: false })
const props = defineProps<{ value?: string; options: { value: string; label: string }[]; emptyLabel: string; custom?: boolean }>()
const emit = defineEmits<{ change: [value: string | undefined] }>()
const attrs = useAttrs()
const editingCustom = ref(false)
const customKey = computed(() => {
  let key = '__custom__'
  while (props.options.some(option => option.value === key)) key += '_'
  return key
})
const unknown = computed(() => !!props.value && !props.options.some(option => option.value === props.value))
function choose(value: string) {
  editingCustom.value = !!props.custom && value === customKey.value
  if (!editingCustom.value) emit('change', value || undefined)
}
</script>
<template>
  <div class="choice-field">
    <select v-bind="attrs" class="input" :value="editingCustom || (custom && unknown) ? customKey : value || ''" @change="choose(($event.target as HTMLSelectElement).value)">
      <option value="">{{ emptyLabel }}</option><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option><option v-if="unknown && !custom" :value="value">{{ value }} (saved)</option><option v-if="custom" :value="customKey">Custom value…</option>
    </select>
    <input v-if="custom && (editingCustom || unknown)" class="input custom-input" :value="value || ''" :aria-label="String(attrs['aria-label'] || 'Setting') + ' custom value'" :data-custom-setting="attrs['data-setting']" autocomplete="off" placeholder="Enter an exact value" @input="emit('change', ($event.target as HTMLInputElement).value || undefined)" />
  </div>
</template>
<style scoped>
.choice-field { display: grid; gap: 8px; min-width: 0; }
.input { width: 100%; min-width: 0; min-height: 40px; padding: 8px 12px; border: 1px solid var(--input); border-radius: var(--radius); background: var(--background); color: var(--foreground); font-size: 14px; }
.input:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
@media (max-width: 760px) { .input { min-height: 44px; font-size: 16.5px; } }
</style>
