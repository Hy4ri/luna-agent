<script setup lang="ts">
import { computed, inject, nextTick, ref } from 'vue'
import { ChevronDown, ChevronRight, Plus, Trash2 } from '@lucide/vue'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu'
import ChoiceField from './ChoiceField.vue'

const props = defineProps<{
  schema: any; path: (string | number)[]; required: boolean
  get: (path: (string | number)[]) => any; set: (path: (string | number)[], value: any) => void
  seed: (schema: any) => any; labelFor: (path: (string | number)[]) => string
  helpFor?: (path: (string | number)[]) => string
}>()
const modelChoices = inject('settingsModelChoices', computed<{ value: string; label: string }[]>(() => []))
const draft = inject('settingsDraft', ref<any>(null))
const disabled = inject('settingsDisabled', computed(() => false))
const safeSchema = computed(() => props.schema || {})
const key = computed(() => String(props.path.at(-1)))
const full = computed(() => props.path.join('.'))
const value = computed(() => props.get(props.path))
const text = computed(() => props.labelFor(props.path))
const helpText = computed(() => props.helpFor?.(props.path))
const descriptionId = computed(() => helpText.value ? 'help-' + encodeURIComponent(JSON.stringify(props.path)) : undefined)
const attrs = computed(() => ({ 'data-setting': full.value, 'aria-label': text.value, 'aria-describedby': descriptionId.value }))
const recursive = computed(() => ({ get: props.get, set: props.set, seed: props.seed, labelFor: props.labelFor, helpFor: props.helpFor }))
const isConst = computed(() => safeSchema.value.const !== undefined || safeSchema.value.enum?.length === 1)
const isModelOverride = computed(() => !props.required && safeSchema.value.type === 'object' && safeSchema.value.properties?.provider && safeSchema.value.properties?.model)
const variants = computed<any[]>(() => safeSchema.value.anyOf || safeSchema.value.oneOf || [])
const selectedVariant = computed(() => variants.value.find(item => item.properties.transport.const === (value.value?.transport || variants.value[0]?.properties.transport.const)))
const nestedObject = computed(() => props.path.length > 1 && !['web.providers', 'browser.providers'].includes(full.value) && !(props.path[0] === 'vision' && props.path[1] === 'profiles' && props.path.length === 3))
const isProfiles = computed(() => full.value === 'vision.profiles')
const itemName = computed(() => ({ mcpServers: 'MCP server', providers: 'provider', models: 'model', skillDirs: 'skill directory', args: 'argument' }[key.value] || 'item'))
const optionLabels: Record<string, string> = { disabled: 'Disabled', ddgs: 'DDGS', camofox: 'Camofox', interrupt: 'Interrupt', queue: 'Queue', steer: 'Steer', native: 'Active model', auxiliary: 'Auxiliary model', on: 'On', moderate: 'Moderate', off: 'Off', low: 'Low', medium: 'Medium', high: 'High', 'openai-completions': 'OpenAI-compatible chat completions', 'openai-responses': 'OpenAI Responses', 'anthropic-messages': 'Anthropic-compatible messages' }
const keyError = ref('')
const expandedKeys = ref<Record<string, boolean>>({})
const choiceOptions = computed<{ value: string; label: string }[] | null>(() => {
  if (full.value === 'image_gen.provider') return [{ value: 'openai-codex', label: 'OpenAI Codex' }]
  if (key.value === 'mcpServer') return [...new Set([safeSchema.value.default, ...(draft.value?.mcpServers || []).map((s: any) => s.name)].filter(Boolean))].map(name => ({ value: String(name), label: String(name) }))
  if (full.value === 'web.providers.ddgs.backend') return [{ value: 'auto', label: 'Automatic' }]
  if (full.value === 'web.providers.ddgs.region') return ['us-en', 'uk-en', 'fr-fr', 'de-de'].map(code => ({ value: code, label: ({ 'us-en': 'United States · English', 'uk-en': 'United Kingdom · English', 'fr-fr': 'France · French', 'de-de': 'Germany · German' } as Record<string, string>)[code]! }))
  if (full.value === 'server.host') return [{ value: '127.0.0.1', label: 'Local only · 127.0.0.1' }, { value: '0.0.0.0', label: 'All IPv4 interfaces · 0.0.0.0' }, { value: '::', label: 'All IPv6 interfaces · ::' }]
  return null
})
function chooseTransport(transport: string) {
  const selected = variants.value.find(item => item.properties.transport.const === transport) || variants.value[0]
  const next = props.seed(selected)
  for (const name of ['name', 'enabled', 'defer', 'timeoutMs']) if (value.value?.[name] !== undefined) next[name] = value.value[name]
  if (value.value?.transport !== 'stdio' && transport !== 'stdio' && value.value?.url) { next.url = value.value.url; next.headers = value.value.headers }
  props.set(props.path, next)
}
function chooseOverride(selected?: string) {
  if (!selected) return props.set(props.path, undefined)
  const slash = selected.indexOf('/')
  props.set(props.path, { provider: selected.slice(0, slash), model: selected.slice(slash + 1) })
}
function addItem() { props.set(props.path, [...(value.value || []), props.seed(safeSchema.value.items)]) }
function removeItem(index: number) { const next = [...(value.value || [])]; next.splice(index, 1); props.set(props.path, next) }
function addEntry() {
  const next = { ...(value.value || {}) }; let n = 1
  const prefix = isProfiles.value ? 'profile_' : 'VARIABLE_'
  while (Object.hasOwn(next, prefix + n)) n++
  next[prefix + n] = isProfiles.value ? props.seed(safeSchema.value.additionalProperties) : ''
  props.set(props.path, next)
}
function removeEntry(name: string) { const next = { ...value.value }; delete next[name]; props.set(props.path, next) }
async function renameEntry(name: string, input: HTMLInputElement) {
  const nextName = input.value.trim()
  if (!nextName || ['__proto__', 'constructor', 'prototype'].includes(nextName) || (nextName !== name && Object.hasOwn(value.value || {}, nextName))) {
    keyError.value = 'Use a unique, nonempty key. Reserved object names are not allowed.'; input.value = name; return
  }
  keyError.value = ''
  const next = Object.fromEntries(Object.entries(value.value || {}).map(([key, item]) => [key === name ? nextName : key, item]))
  expandedKeys.value[nextName] = expandedKeys.value[name] || false
  props.set(props.path, next)
  await nextTick()
}
function setExtension(option: string, checked: boolean | 'indeterminate') {
  props.set(props.path, safeSchema.value.items.enum.filter((item: string) => item === option ? checked === true : (value.value || []).includes(item)))
}
function titleCase(value: string) { return value.replace(/-/g, ' ').replace(/^./, letter => letter.toUpperCase()) }
</script>

<template>
  <label v-if="isConst" class="field-label"><span>{{ text }}</span><input class="input readonly-value" :value="safeSchema.const ?? safeSchema.enum[0]" readonly v-bind="attrs" /><small v-if="helpText" :id="descriptionId">{{ helpText }}</small></label>
  <div v-else-if="variants.length" class="field-stack">
    <label class="field-label"><span>Transport</span><select class="input" :value="value?.transport || variants[0].properties.transport.const" :data-setting="full + '.transport'" :aria-label="text + ' Transport'" @change="chooseTransport(($event.target as HTMLSelectElement).value)"><option v-for="variant in variants" :key="variant.properties.transport.const" :value="variant.properties.transport.const">{{ variant.properties.transport.const }}</option></select></label>
    <template v-for="(schema, name) in selectedVariant.properties" :key="name"><ComponentField v-if="name !== 'transport'" :schema="schema" :path="[...path, name]" :required="(selectedVariant.required || []).includes(name)" v-bind="recursive" /></template>
  </div>
  <details v-else-if="isModelOverride" class="field-group" :data-section="full">
    <summary><ChevronRight :size="15" /><span>{{ text }}</span><small>{{ value ? value.provider + '/' + value.model : 'Use default' }}</small></summary>
    <div class="field-stack group-body">
      <p v-if="helpText" :id="descriptionId" class="field-help">{{ helpText }}</p>
      <label class="field-label"><span>Model</span><ChoiceField :value="value ? value.provider + '/' + value.model : undefined" :options="modelChoices" empty-label="Use default" v-bind="attrs" @change="chooseOverride" /></label>
      <details class="field-group subtle-group"><summary><ChevronRight :size="15" /><span>Custom provider and model IDs</span></summary><div class="field-stack group-body">
        <button v-if="value === undefined" type="button" class="field-button" @click="set(path, seed(safeSchema))">Set {{ text }}</button>
        <template v-else><ComponentField v-for="(schema, name) in safeSchema.properties" :key="name" :schema="schema" :path="[...path, name]" :required="(safeSchema.required || []).includes(name)" v-bind="recursive" /></template>
      </div></details>
    </div>
  </details>
  <component :is="nestedObject ? 'details' : 'div'" v-else-if="safeSchema.type === 'object' && safeSchema.properties" :class="nestedObject ? 'field-group' : 'field-stack'" :data-field-group="full">
    <summary v-if="nestedObject"><ChevronRight :size="15" /><span>{{ text }}</span></summary>
    <div :class="['field-stack', { 'group-body': nestedObject }]"><p v-if="helpText && path.length > 1" :id="descriptionId" class="field-help">{{ helpText }}</p><ComponentField v-for="(schema, name) in safeSchema.properties" :key="name" :schema="schema" :path="[...path, name]" :required="(safeSchema.required || []).includes(name)" v-bind="recursive" /></div>
  </component>
  <component :is="path.length > 1 ? 'details' : 'div'" v-else-if="safeSchema.type === 'object'" :class="path.length > 1 ? 'field-group' : 'field-stack'" :data-field-group="full">
    <summary v-if="path.length > 1"><ChevronRight :size="15" /><span>{{ text }}</span><small>{{ Object.keys(value || {}).length }} entries</small></summary>
    <div class="field-stack" :class="{ 'group-body': path.length > 1 }">
      <div class="field-toolbar"><span class="field-help">{{ helpText }}</span><button type="button" class="field-button" @click="addEntry"><Plus :size="14" />{{ isProfiles ? 'Add vision profile' : key === 'headers' ? 'Add header' : key === 'env' ? 'Add environment variable' : 'Add item' }}</button></div>
      <p v-if="keyError" role="alert" class="field-error">{{ keyError }}</p><p v-if="!Object.keys(value || {}).length" class="empty-value">No entries configured.</p>
      <details v-for="(item, name) in (value || {})" :key="name" class="field-group" :open="expandedKeys[String(name)] || false" @toggle="expandedKeys[String(name)] = ($event.target as HTMLDetailsElement).open">
        <summary><ChevronRight :size="15" /><span>{{ name }}</span></summary>
        <div class="field-stack group-body">
          <label class="field-label"><span>{{ isProfiles ? 'Vision profiles key' : 'Key' }}</span><input class="input" :value="name" :aria-label="isProfiles ? 'Vision profiles key' : text + ' key'" autocomplete="off" @change="renameEntry(String(name), $event.target as HTMLInputElement)" /></label>
          <ComponentField v-if="isProfiles" :schema="safeSchema.additionalProperties" :path="[...path, String(name)]" :required="true" v-bind="recursive" />
          <label v-else class="field-label"><span>Value</span><input class="input" type="password" :value="item" :data-setting="full + '.' + name" :aria-label="text + ' value'" autocomplete="new-password" @input="set([...path, name], ($event.target as HTMLInputElement).value)" /></label>
          <div class="field-actions"><button type="button" class="field-button danger" @click="removeEntry(String(name))"><Trash2 :size="14" />Remove {{ name }}</button></div>
        </div>
      </details>
    </div>
  </component>
  <div v-else-if="safeSchema.type === 'array' && safeSchema.items?.enum" class="field-stack">
    <DropdownMenu><DropdownMenuTrigger as-child><button class="input choice-trigger" type="button" aria-label="Choose built-in tools" v-bind="{ 'data-setting': full }" :disabled="disabled"><span>{{ (value || []).length }} enabled</span><ChevronDown :size="16" /></button></DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-72 max-w-[calc(100vw-32px)]" :aria-label="text"><DropdownMenuCheckboxItem v-for="option in safeSchema.items.enum" :key="option" :aria-label="titleCase(option)" :model-value="(value || []).includes(option)" :disabled="disabled" class="min-h-10" @select.prevent @update:model-value="setExtension(option, $event)">{{ titleCase(option) }}</DropdownMenuCheckboxItem></DropdownMenuContent>
    </DropdownMenu>
    <p class="field-help">Choose the tools Luna can use. Changes apply after a restart.</p>
  </div>
  <div v-else-if="safeSchema.type === 'array'" class="field-stack">
    <div class="field-toolbar"><span class="field-help">{{ value?.length || 0 }} configured</span><button class="field-button" type="button" @click="addItem"><Plus :size="14" />Add {{ itemName }}</button></div>
    <p v-if="!value?.length" class="empty-value">No items added.</p>
    <template v-for="(item, index) in (value || [])" :key="index">
      <div v-if="safeSchema.items?.type === 'string'" class="string-item"><ComponentField :schema="safeSchema.items" :path="[...path, Number(index)]" :required="true" v-bind="recursive" /><button type="button" class="field-button danger" @click="removeItem(Number(index))">Remove</button></div>
      <details v-else class="field-group" :data-section="full + '.' + index"><summary><ChevronRight :size="15" /><span>{{ item.name || item.id || itemName + ' ' + (Number(index) + 1) }}</span></summary><div class="field-stack group-body"><ComponentField :schema="safeSchema.items" :path="[...path, Number(index)]" :required="true" v-bind="recursive" /><div class="field-actions"><button class="field-button danger" type="button" @click="removeItem(Number(index))"><Trash2 :size="14" />Remove {{ itemName }} {{ Number(index) + 1 }}</button></div></div></details>
    </template>
  </div>
  <label v-else-if="safeSchema.enum || (safeSchema.type === 'boolean' && !required)" class="field-label"><span>{{ text }}</span><select v-bind="attrs" class="input" :value="value === undefined ? '' : String(value)" @change="set(path, ($event.target as HTMLSelectElement).value === '' && !required ? undefined : safeSchema.type === 'boolean' ? ($event.target as HTMLSelectElement).value === 'true' : ($event.target as HTMLSelectElement).value)"><option v-if="!required" value="">{{ safeSchema.default !== undefined ? `Use default (${safeSchema.default})` : 'Use default' }}</option><option v-for="option in safeSchema.enum || [true, false]" :key="String(option)" :value="String(option)">{{ safeSchema.type === 'boolean' ? (option ? 'Yes' : 'No') : optionLabels[option] || option }}</option></select><small v-if="helpText" :id="descriptionId">{{ helpText }}</small></label>
  <label v-else-if="safeSchema.type === 'boolean'" class="boolean-field"><span><span class="boolean-title">{{ text }}</span><small v-if="helpText" :id="descriptionId">{{ helpText }}</small></span><input type="checkbox" v-bind="attrs" :checked="value ?? safeSchema.default ?? false" @change="set(path, ($event.target as HTMLInputElement).checked)" /></label>
  <label v-else-if="choiceOptions" class="field-label"><span>{{ text }}</span><ChoiceField :value="value" :options="choiceOptions" :empty-label="required ? (safeSchema.default !== undefined ? 'Use default (' + safeSchema.default + ')' : 'Select a value') : 'Not selected'" custom v-bind="attrs" @change="set(path, $event)" /><small v-if="helpText" :id="descriptionId">{{ helpText }}</small></label>
  <label v-else class="field-label"><span>{{ text }}</span><component :is="key === 'instructions' ? 'textarea' : 'input'" v-bind="attrs" class="input" :type="['number', 'integer'].includes(safeSchema.type) ? 'number' : 'text'" :rows="key === 'instructions' ? 4 : undefined" :step="safeSchema.type === 'integer' ? '1' : safeSchema.type === 'number' ? 'any' : undefined" :min="safeSchema.minimum" :max="safeSchema.maximum" :value="value ?? ''" autocomplete="off" placeholder="Not set" @input="set(path, ($event.target as HTMLInputElement).value === '' && !required ? undefined : ['number', 'integer'].includes(safeSchema.type) ? Number(($event.target as HTMLInputElement).value) : ($event.target as HTMLInputElement).value)" /><small v-if="helpText" :id="descriptionId">{{ helpText }}</small></label>
</template>

<style scoped>
.field-stack { display: grid; gap: 16px; min-width: 0; }
.field-label { display: grid; gap: 6px; min-width: 0; font-size: 14px; font-weight: 500; }
.field-label small, .boolean-field small, .field-help { display: block; font-size: 13px; color: var(--muted-foreground); line-height: 1.6; font-weight: 400; }
.input { width: 100%; min-width: 0; min-height: 40px; padding: 8px 12px; border: 1px solid var(--input); border-radius: 6px; background: var(--background); color: var(--foreground); font-size: 14px; }
.input:not(button):focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.readonly-value { color: var(--muted-foreground); background: var(--muted); cursor: text; }
.field-group { min-width: 0; border: 1px solid var(--border); border-radius: 6px; }
.field-group > summary { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 10px 12px; cursor: pointer; font-size: 14px; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary svg { flex-shrink: 0; color: var(--muted-foreground); }
summary span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
summary small { font-size: 12px; color: var(--muted-foreground); overflow-wrap: anywhere; max-width: 50%; }
.field-group[open] > summary > svg { transform: rotate(90deg); }
.group-body { padding: 16px; border-top: 1px solid var(--border); }
.subtle-group { border: 0; border-top: 1px solid var(--border); border-radius: 0; }
.field-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.field-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 5px; font-size: 13px; cursor: pointer; }
.field-button:hover { background: var(--accent); }
.danger { color: var(--destructive); }
.field-actions { display: flex; justify-content: flex-end; }
.empty-value { font-size: 13px; color: var(--muted-foreground); padding-block: 8px; }
.field-error { color: var(--destructive); font-size: 13px; }
.boolean-field { display: flex; justify-content: space-between; align-items: center; gap: 16px; min-height: 44px; cursor: pointer; }
.boolean-title { font-size: 14px; font-weight: 500; }
.boolean-field input { width: 16px; height: 16px; flex-shrink: 0; accent-color: var(--primary); }
.string-item { display: flex; align-items: flex-end; gap: 8px; }
.string-item > :first-child { flex: 1; min-width: 0; }
.choice-trigger { display: flex; justify-content: space-between; align-items: center; cursor: pointer; }
textarea.input { min-height: 100px; resize: vertical; font-size: 15px; font-weight: 450; }
@media (max-width: 760px) { .input { min-height: 44px; font-size: 16.5px; } .field-button { min-height: 44px; } .group-body { padding: 12px; } }
</style>
