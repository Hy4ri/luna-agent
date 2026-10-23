<script setup lang="ts">
import { computed, provide, ref, toRaw, watch, inject, onUnmounted } from 'vue'
import ComponentField from './ComponentField.vue'
import { labelFor, helpFor } from './catalog'
import { json, post } from '@/lib/api'
const props = defineProps<{ collection: 'providers' | 'mcpServers'; name: string }>()
const emit = defineEmits<{ busy: [busy: boolean]; changed: [] }>()
const pendingForms = inject('settingsPendingForms', ref(new Set<string>()))
const formId = `${props.collection}:${props.name}`
const view = ref<any>(null)
const draft = ref<any>(null)
const baseline = ref('')
const open = ref(false)
const busy = ref(false)
const error = ref('')
const message = ref('')
const index = ref(-1)
const dirty = computed(() => !!draft.value && JSON.stringify(draft.value[props.collection][index.value]) !== baseline.value)
watch([open, dirty], () => {
  if (open.value && dirty.value) pendingForms.value.add(formId)
  else pendingForms.value.delete(formId)
}, { flush: 'sync' })
onUnmounted(() => pendingForms.value.delete(formId))
provide('settingsDraft', draft)
provide('settingsDisabled', busy)
watch(busy, value => emit('busy', value), { flush: 'sync' })
async function edit() {
  busy.value = true; error.value = ''; message.value = ''
  try {
    const data = await json('/v1/settings')
    view.value = data
    draft.value = structuredClone(data.config)
    index.value = draft.value[props.collection].findIndex((item: any) => (props.collection === 'providers' ? item.id : item.name) === props.name)
    if (index.value < 0) throw new Error('This definition is not in the settings file. Reload the connection list.')
    baseline.value = JSON.stringify(draft.value[props.collection][index.value])
    open.value = true
  } catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
function get(path: (string | number)[]) { return path.reduce<any>((value, name) => value?.[name], draft.value) }
function set(path: (string | number)[], value: any) {
  let target = draft.value
  for (const name of path.slice(0, -1)) { if (target[name] == null) target[name] = {}; target = target[name] }
  if (value === undefined) delete target[path.at(-1)!]
  else target[path.at(-1)!] = value
}
function seed(schema: any): any {
  if (schema.default !== undefined) return structuredClone(schema.default)
  if (schema.const !== undefined) return schema.const
  if (schema.enum) return schema.enum[0]
  const variants = schema.anyOf || schema.oneOf
  if (variants) return seed(variants.find((item: any) => item.properties?.transport?.const === 'http') || variants[0])
  if (schema.type === 'object') return Object.fromEntries((schema.required || []).map((key: string) => [key, seed(schema.properties[key])]))
  if (schema.type === 'array') return []
  if (schema.type === 'boolean') return false
  return ['number', 'integer'].includes(schema.type) ? schema.minimum ?? 1 : ''
}
async function save() {
  if (!dirty.value || busy.value) return
  busy.value = true; error.value = ''
  try {
    // Revision checks refuse concurrent writes instead of overwriting another editor.
    const result = await post('/v1/settings', { config: toRaw(draft.value), revision: view.value.revision }, 'PUT')
    message.value = (result.warnings || []).join(' ') || 'Definition saved and applied.'
    open.value = false
    emit('changed')
  } catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
function cancel() { open.value = false; draft.value = null; error.value = '' }
</script>
<template>
  <div class="definition-editor">
    <button v-if="!open" type="button" :disabled="busy" @click="edit">Edit definition</button>
    <template v-else>
      <p class="muted">Save definition applies this change immediately. Unchanged secret markers retain stored credentials.</p>
      <fieldset :disabled="busy">
        <ComponentField :schema="view.schema.properties[collection].items" :path="[collection, index]" :required="true" :get="get" :set="set" :seed="seed" :label-for="labelFor" :help-for="helpFor" />
        <div class="actions"><button type="button" :disabled="!dirty" @click="save">{{ busy ? 'Saving…' : 'Save definition' }}</button><button type="button" @click="cancel">Cancel</button></div>
      </fieldset>
    </template>
    <p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="message" role="status" class="muted">{{ message }}</p>
  </div>
</template>
<style scoped>
.definition-editor { display: grid; gap: 12px; min-width: 0; }
fieldset { border: 0; padding: 0; min-width: 0; display: grid; gap: 16px; }
.actions { display: flex; gap: 8px; }
button { min-height: 44px; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; width: fit-content; }
button:hover { background: var(--accent); }
.error { color: var(--destructive); }
</style>
