<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { json } from '@/lib/api'
const props = defineProps<{ kind: 'tools' | 'skills'; value: string[]; disabled: boolean }>()
const emit = defineEmits<{ change: [value: string[]] }>()
const loading = ref(true)
const error = ref('')
const filter = ref('')
const choices = ref<{ name: string; description?: string }[]>([])
// Retain unavailable names during this edit so a cleared checkbox can be restored.
const knownNames = ref<string[]>([...props.value])
watch(() => props.value, names => { knownNames.value = [...new Set([...knownNames.value, ...names])] })
const items = computed(() => {
  const all = new Map(choices.value.map(item => [item.name, item]))
  for (const name of knownNames.value) if (!all.has(name)) all.set(name, { name, description: 'Saved disabled item. It may be unavailable in the current catalog.' })
  const terms = filter.value.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return [...all.values()].sort((a, b) => a.name.localeCompare(b.name)).filter(item => terms.every(term => `${item.name} ${item.description || ''}`.toLocaleLowerCase().includes(term)))
})
async function load() {
  loading.value = true; error.value = ''
  try {
    const data = await json(`/v1/${props.kind}`)
    choices.value = props.kind === 'tools' ? [...data.tools, ...data.deferred] : data.skills
  } catch (e) { error.value = (e as Error).message || `Could not load ${props.kind}.` }
  finally { loading.value = false }
}
function toggle(name: string, checked: boolean) {
  if (props.disabled) return
  emit('change', checked ? [...new Set([...props.value, name])] : props.value.filter(item => item !== name))
}
onMounted(load)
watch(() => props.kind, load)
</script>
<template>
  <div :data-setting="kind === 'tools' ? 'disabledTools' : 'disabledSkills'" tabindex="-1" class="disabled-items">
    <p class="help">Checked items are disabled. Changes use Save settings.</p>
    <label class="filter"><span>Filter {{ kind }}</span><input v-model="filter" type="search" :aria-label="`Filter ${kind}`" :disabled="disabled" /></label>
    <p v-if="loading" role="status">Loading {{ kind }}…</p>
    <p v-if="error" role="alert">{{ error }} <button type="button" :disabled="disabled || loading" @click="load">Retry</button></p>
    <div class="items">
      <label v-for="item in items" :key="item.name" class="item"><input type="checkbox" :checked="value.includes(item.name)" :disabled="disabled" :aria-label="`Disable ${item.name}`" @change="toggle(item.name, ($event.target as HTMLInputElement).checked)" /><span><strong>{{ item.name }}</strong><small>{{ item.description }}</small></span></label>
    </div>
    <p v-if="!loading && !error && !items.length" class="help">{{ filter ? 'No matching items.' : `No ${kind} are available.` }}</p>
  </div>
</template>
<style scoped>
.disabled-items { display: grid; gap: 12px; min-width: 0; }
.help, small, p { font-size: 13px; color: var(--muted-foreground); line-height: 1.5; }
.filter { display: grid; gap: 6px; font-size: 14px; }
.filter input { min-width: 0; width: 100%; min-height: 44px; padding: 8px 12px; font-size: 16px; border: 1px solid var(--input); background: var(--background); border-radius: var(--radius); }
.items { max-height: 360px; overflow-y: auto; }
.item { display: flex; align-items: flex-start; gap: 12px; padding: 12px 0; min-height: 44px; border-bottom: 1px solid var(--border); cursor: pointer; }
.item input { flex-shrink: 0; margin-top: 3px; width: 18px; height: 18px; accent-color: var(--primary); }
.item span { min-width: 0; overflow-wrap: anywhere; }
strong { display: block; font-size: 14px; font-weight: 500; }
small { display: block; margin-top: 4px; }
button { min-height: 44px; text-decoration: underline; }
.filter input:focus-visible, .item input:focus-visible, button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
</style>
