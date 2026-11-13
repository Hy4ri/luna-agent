<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { Search } from '@lucide/vue'
import { matchSettings, settingsIndex, type SettingsResult } from './settingsSearch'
const props = defineProps<{ schema: any; config: any; disabled: boolean }>()
const emit = defineEmits<{ select: [result: SettingsResult] }>()
const query = ref('')
const active = ref(0)
const results = computed(() => matchSettings(settingsIndex(props.schema, props.config), query.value))
watch(query, () => { active.value = 0 })
function choose(item: SettingsResult) { emit('select', item); query.value = '' }
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { query.value = ''; return }
  if (event.key === 'Enter' && !event.isComposing && results.value[active.value]) { event.preventDefault(); choose(results.value[active.value]!); return }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !results.value.length) return
  event.preventDefault()
  active.value = (active.value + (event.key === 'ArrowDown' ? 1 : -1) + results.value.length) % results.value.length
  void nextTick(() => document.getElementById(`setting-result-${active.value}`)?.scrollIntoView({ block: 'nearest' }))
}
</script>
<template>
  <div class="settings-search">
    <label class="search-label"><Search :size="18" /><span class="sr-only">Search settings</span><input v-model="query" :disabled="disabled" type="search" role="combobox" aria-label="Search settings" aria-controls="settings-results" :aria-expanded="!!query.trim()" :aria-activedescendant="results.length ? `setting-result-${active}` : undefined" placeholder="Search settings…" autocomplete="off" @keydown="keydown" /></label>
    <div v-if="query.trim()" id="settings-results" class="search-results" role="listbox" aria-label="Settings results">
      <button v-for="(item, index) in results" :id="`setting-result-${index}`" :key="item.id" role="option" :aria-selected="active === index" class="search-result" type="button" :disabled="disabled" @pointermove="active = index" @click="choose(item)"><strong>{{ item.title }}</strong><span>{{ item.breadcrumb }}</span><small>{{ item.summary }} · {{ item.timing }}</small></button>
      <p v-if="!results.length" role="status">No matching settings.</p>
    </div>
  </div>
</template>
<style scoped>
.settings-search { position: relative; padding: 12px 32px; border-bottom: 1px solid var(--border); flex-shrink: 0; z-index: 2; }
.search-label { display: flex; align-items: center; gap: 10px; max-width: 720px; margin-inline: auto; color: var(--muted-foreground); }
input { width: 100%; min-width: 0; min-height: 44px; padding: 10px 12px; border: 1px solid var(--input); border-radius: var(--radius); color: var(--foreground); background: var(--background); font-size: 16px; }
.search-results { position: absolute; top: calc(100% - 8px); left: 16px; right: 16px; max-width: 760px; margin: auto; max-height: min(50dvh, 480px); overflow-y: auto; border: 1px solid var(--border); background: var(--background); box-shadow: 0 12px 30px rgb(0 0 0 / 0.4); }
.search-result { display: flex; flex-direction: column; gap: 3px; width: 100%; min-height: 64px; padding: 12px 16px; text-align: left; border-bottom: 1px solid var(--border); cursor: pointer; }
.search-result[aria-selected=true] { background: var(--accent); }
.search-result strong { font-size: 14px; font-weight: 600; }
.search-result span, .search-result small, p { font-size: 12px; color: var(--muted-foreground); overflow-wrap: anywhere; }
p { padding: 16px; }
@media (max-width: 760px) { .settings-search { padding: 8px 16px; } }
</style>
