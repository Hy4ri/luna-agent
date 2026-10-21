<script setup lang="ts">
import { computed, ref, provide, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { ui, setSettingsGuard, setDrawer, navigate, setSettingsTab, settingsChanged } from '@/stores/app'
import { scheduleContext } from '@/stores/chat'
import { loadModels, models } from '@/stores/models'
import { json, post } from '@/lib/api'
import { useMobile } from '@/lib/dom'
import ComponentField from './settings/ComponentField.vue'
import SettingsGroup from './settings/SettingsGroup.vue'
import { PANELS } from '@/components/panels'
import { sections, fieldTitles, labelFor, helpFor, summaries, timing, managers } from './settings/catalog'
import { Menu, ArrowLeft, ArrowUpRight, MessageSquare, Network, BookOpen, Image, Wrench, Clock, Settings2, AlertCircle, RefreshCw } from '@lucide/vue'

const mobile = useMobile()
const icons = [MessageSquare, Network, BookOpen, Image, Wrench, Clock, Settings2]
const saved = ref<any>(null)
const draft = ref<any>(null)
const baseline = ref('')
const loading = ref(true)
const loadError = ref<string | null>(null)
const statusText = ref('')
const saveError = ref(false)
const isSaving = ref(false)
const isReloading = ref(false)
const isRefreshingModels = ref(false)
const modelRefreshMessage = ref('')
const content = ref<HTMLElement | null>(null)
const activeTab = computed(() => sections.some(s => s.id === ui.settingsTab) ? ui.settingsTab : 'general')
const section = computed(() => sections.find(s => s.id === activeTab.value)!)
const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== baseline.value)
const activeView = ref('configuration')
const managerBusy = ref(false)
const sectionViews = computed(() => (managers[activeTab.value] || []).filter(item => PANELS[item.id]))
const sectionLinks = computed(() => (managers[activeTab.value] || []).filter(item => !PANELS[item.id]))
const activeManager = computed(() => sectionViews.value.find(item => item.id === activeView.value))
const sharesConfig = computed(() => ['providers', 'mcp'].includes(activeView.value))
const disabled = computed(() => isSaving.value || isReloading.value || managerBusy.value)
async function selectView(id: string, focus = false) {
  if (disabled.value || loading.value) return
  activeView.value = id
  await nextTick()
  if (focus) document.getElementById(`settings-view-${id}`)?.focus({ preventScroll: true })
}
function moveView(event: KeyboardEvent, index: number) {
  const ids = ['configuration', ...sectionViews.value.map(item => item.id)]
  let next: number
  if (event.key === 'ArrowRight') next = (index + 1) % ids.length
  else if (event.key === 'ArrowLeft') next = (index - 1 + ids.length) % ids.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = ids.length - 1
  else return
  event.preventDefault()
  void selectView(ids[next]!, true)
}
function managerChanged() {
  // Shared configuration writes are allowed only with a clean draft.
  // Reload their new revision before Save can write an older snapshot.
  if (sharesConfig.value && !dirty.value) void loadSettings()
}
const thinkingLevels = computed<string[]>(() => saved.value?.schema.properties.thinkingLevel.enum || [])
const choices = computed(() => {
  const result = new Map<string, string>()
  for (const m of models.list) result.set(`${m.provider}/${m.id}`, `${m.provider} · ${m.name || m.id}`)
  for (const p of draft.value?.providers || []) for (const m of p.models || []) {
    if (p.id && m.id) result.set(`${p.id}/${m.id}`, `${p.name || p.id} · ${m.name || m.id}`)
  }
  return [...result].map(([value, label]) => ({ value, label }))
})
provide('settingsModelChoices', choices)
provide('settingsDraft', draft)
provide('settingsDisabled', disabled)
function groupStatus(key: string): string {
  const value = draft.value?.[key]
  if (key === 'models-main') return modelValue() || 'Runtime default'
  if (key === 'models-subagents') return modelValue(true) || 'Inherit parent model'
  if (key === 'models-refresh') return `${models.list.length} models available`
  if (Array.isArray(value)) return `${value.length} ${key === 'extensions' ? 'enabled' : 'configured'}`
  if (key === 'busyInput') return `${value?.mode || 'interrupt'} mode`
  if (key === 'vision') return value?.image_mode === 'auxiliary' ? 'Auxiliary model' : 'Active model'
  if (key === 'image_gen') return value?.provider || 'No provider selected'
  if (key === 'auxiliary') return `${Object.values(value || {}).filter(Boolean).length} model overrides`
  if (key === 'web') return `${value?.searchProvider === 'disabled' ? 'Search off' : 'DDGS search'} · ${value?.extractProvider === 'disabled' ? 'extraction off' : 'DDGS extraction'}`
  if (key === 'browser') return value?.provider === 'disabled' ? 'Disabled' : value?.provider || 'Disabled'
  if (key === 'server') return `${value?.host}:${value?.port}`
  if (key === 'learn') return `Scan after ${value?.idleMinutes} idle minutes`
  if (key === 'cron') return value?.runTimeoutMinutes ? `${value.runTimeoutMinutes} minute limit` : 'No run time limit'
  if (key === 'improve') return value?.schedule ? 'Scheduled' : 'No scheduled checks'
  if (value && typeof value.enabled === 'boolean') return value.enabled ? 'Enabled' : 'Disabled'
  if (typeof value === 'string') return key === 'instructions' ? 'Custom instructions' : value
  return 'Not configured'
}
function modelValue(child = false) {
  const config = child ? draft.value?.subagents : draft.value
  return config?.provider && config?.model ? `${config.provider}/${config.model}` : ''
}
function chooseModel(value: string, child = false) {
  const path = child ? ['subagents'] : []
  if (!value) {
    setVal([...path, 'provider'], child ? undefined : 'faux')
    setVal([...path, 'model'], undefined)
    return
  }
  const slash = value.indexOf('/')
  setVal([...path, 'provider'], value.slice(0, slash))
  setVal([...path, 'model'], value.slice(slash + 1))
}
async function selectTab(id: string, focus = false) {
  if (disabled.value || loading.value) return
  setSettingsTab(id)
  await nextTick()
  if (content.value) content.value.scrollTop = 0
  if (focus) {
    const button = document.getElementById(`settings-tab-${id}`)
    button?.focus({ preventScroll: true })
    button?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
}
function moveTab(event: KeyboardEvent, index: number) {
  let next: number
  if (['ArrowRight', 'ArrowDown'].includes(event.key)) next = (index + 1) % sections.length
  else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) next = (index - 1 + sections.length) % sections.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = sections.length - 1
  else return
  event.preventDefault()
  void selectTab(sections[next]!.id, true)
}
watch(activeTab, async () => {
  activeView.value = 'configuration'
  await nextTick()
  document.getElementById(`settings-tab-${activeTab.value}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
})
let mounted = true
async function loadSettings() {
  loading.value = true
  loadError.value = null
  try {
    const [res] = await Promise.all([json('/v1/settings'), loadModels()])
    if (!mounted) return
    saved.value = res
    draft.value = structuredClone(res.config)
    baseline.value = JSON.stringify(draft.value)
    saveError.value = false
    statusText.value = res.restartRequired ? 'Saved. Restart Luna to apply runtime changes.' : 'No unsaved changes.'
  } catch (e: any) {
    if (mounted) loadError.value = e.message || 'Failed to load settings'
  } finally {
    if (mounted) loading.value = false
  }
}
async function saveSettings() {
  if (disabled.value || !saved.value) return
  isSaving.value = true
  saveError.value = false
  try {
    const res = await post('/v1/settings', { config: draft.value, revision: saved.value.revision }, 'PUT')
    if (!mounted) return
    saved.value = res
    draft.value = structuredClone(res.config)
    baseline.value = JSON.stringify(draft.value)
    await loadModels()
    scheduleContext()
    statusText.value = res.restartRequired ? 'Saved. Restart Luna to apply runtime changes.' : 'Settings saved. Compaction changes apply now. New sessions and subagents use the new defaults.'
  } catch (e: any) {
    statusText.value = e.message || 'Failed to save settings'
    saveError.value = true
  } finally { isSaving.value = false }
}
async function reloadSettings() {
  if (disabled.value || !confirm('Discard unsaved edits and reload settings?')) return
  isReloading.value = true
  try { await loadSettings() } finally { isReloading.value = false }
}
async function refreshModels() {
  if (isRefreshingModels.value) return
  isRefreshingModels.value = true
  modelRefreshMessage.value = ''
  try {
    const result = await post('/v1/models/refresh')
    if (!await loadModels()) throw new Error('Refresh finished, but the updated catalog could not be loaded. Try again.')
    const errors = Object.entries(result.refresh.errors).map(([id, message]) => `${id}: ${message}`)
    modelRefreshMessage.value = errors.length ? `Refresh incomplete. ${errors.join('; ')}` : 'Model catalog refreshed.'
  } catch (e: any) { modelRefreshMessage.value = e.message || 'Model refresh failed. Existing models are kept.' }
  finally { isRefreshingModels.value = false }
}
function getVal(path: (string | number)[]) {
  return path.reduce<any>((value, key) => value?.[key], draft.value)
}
function setVal(path: (string | number)[], value: any) {
  let target = draft.value
  for (const key of path.slice(0, -1)) {
    if (target[key] == null) target[key] = {}
    target = target[key]
  }
  const key = path.at(-1)!
  if (value === undefined) delete target[key]
  else target[key] = value
  saveError.value = false
  statusText.value = 'Unsaved changes.'
}
function seedSchema(schema: any): any {
  if (schema.default !== undefined) return JSON.parse(JSON.stringify(schema.default))
  const variants = schema.anyOf || schema.oneOf
  if (variants) return seedSchema(variants.find((s: any) => s.properties?.transport?.const === 'http') || variants[0])
  if (schema.const !== undefined) return schema.const
  if (schema.enum) return schema.enum[0]
  if (schema.type === 'array') return []
  if (schema.type === 'object') return Object.fromEntries((schema.required || []).map((key: string) => [key, seedSchema(schema.properties[key])]))
  return schema.type === 'boolean' ? false : ['number', 'integer'].includes(schema.type) ? (schema.minimum ?? 1) : ''
}
onMounted(() => {
  setSettingsGuard({ canLeave: () => !disabled.value && (!dirty.value || confirm('Discard unsaved settings?')), isDirty: () => dirty.value || disabled.value, canChangeTab: () => !disabled.value })
  void loadSettings()
})
onUnmounted(() => { mounted = false; setSettingsGuard(null) })
// The command palette writes only while this page has no unsaved edits; load its new revision.
watch(settingsChanged, () => { if (!dirty.value && !disabled.value) void loadSettings() })
</script>

<template>
  <div id="settings-screen" class="settings-screen">
    <header class="settings-header">
      <button id="settings-menu" class="icon-button mobile-only" type="button" aria-label="Open navigation" aria-controls="side" :aria-expanded="ui.drawer" @click="setDrawer(true)"><Menu :size="20" /></button>
      <div class="settings-heading"><h1>Settings</h1><p>Make Luna work the way you do.</p></div>
      <button class="settings-button back-button" type="button" data-settings-close :disabled="disabled" @click="navigate('chat')"><ArrowLeft :size="16" /><span>Back to chat</span></button>
    </header>
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Settings sections">
        <div class="settings-tabs" role="tablist" aria-label="Settings sections" :aria-orientation="mobile ? 'horizontal' : 'vertical'">
          <button v-for="(item, index) in sections" :id="'settings-tab-' + item.id" :key="item.id" type="button" role="tab" :data-settings-tab="item.id" aria-controls="settings-fields" :aria-selected="activeTab === item.id" :tabindex="activeTab === item.id ? 0 : -1" :disabled="disabled || loading" @click="selectTab(item.id)" @keydown="moveTab($event, index)"><component :is="icons[index]" :size="18" /><span>{{ item.title }}</span></button>
        </div>
      </nav>
      <div ref="content" class="settings-scroll">
        <div id="settings-fields" class="settings-content" role="tabpanel" :aria-labelledby="'settings-tab-' + activeTab" tabindex="0">
          <div class="section-heading"><h2>{{ section.title }}</h2><p>{{ section.description }}</p></div>
          <div v-if="loading" class="settings-loading" role="status">Loading settings…</div>
          <div v-else-if="loadError" class="settings-error"><p role="alert"><AlertCircle :size="18" />{{ loadError }}</p><button class="settings-button" type="button" @click="loadSettings">Retry</button></div>

          <div v-if="sectionViews.length" class="settings-subtabs" role="tablist" :aria-label="section.title + ' views'" aria-orientation="horizontal">
            <button id="settings-view-configuration" type="button" role="tab" data-settings-view="configuration" aria-controls="settings-configuration" :aria-selected="activeView === 'configuration'" :tabindex="activeView === 'configuration' ? 0 : -1" :disabled="disabled || loading" @click="selectView('configuration')" @keydown="moveView($event, 0)">Configuration</button>
            <button v-for="(item, index) in sectionViews" :id="'settings-view-' + item.id" :key="item.id" type="button" role="tab" :data-settings-view="item.id" aria-controls="settings-management" :aria-selected="activeView === item.id" :tabindex="activeView === item.id ? 0 : -1" :disabled="disabled || loading" @click="selectView(item.id)" @keydown="moveView($event, index + 1)">{{ item.title }}</button>
          </div>
          <section v-if="activeManager" id="settings-management" class="settings-management" role="tabpanel" :aria-labelledby="'settings-view-' + activeView" tabindex="0">
            <p class="manager-description">{{ activeManager.description }}</p>
            <p v-if="sharesConfig && dirty" class="manager-notice" role="status">Save or reload your settings draft before changing accounts or connections. Your edits are kept.</p>
            <p v-else-if="sharesConfig" class="manager-notice">These actions save immediately. They do not use Save settings.</p>
            <fieldset class="settings-manager" :disabled="isSaving || isReloading || (sharesConfig && (!saved || !!loadError || loading || dirty))">
              <component :is="PANELS[activeView]?.component" :key="activeView" @busy="managerBusy = $event" @changed="managerChanged" />
            </fieldset>
          </section>

          <div v-if="sectionLinks.length && activeView === 'configuration'" class="manager-grid" aria-label="Related pages">
            <button v-for="manager in sectionLinks" :key="manager.id" type="button" class="manager-link" :data-panel="manager.id" :disabled="disabled" @click="navigate(manager.id as 'cron' | 'analytics')"><div><strong>{{ manager.title }}</strong><p>{{ manager.description }}</p></div><ArrowUpRight :size="18" /></button>
          </div>

          <fieldset v-if="saved && draft && !loading && !loadError" v-show="activeView === 'configuration'" id="settings-configuration" class="settings-body" :disabled="disabled" aria-label="Configuration settings" :role="sectionViews.length ? 'tabpanel' : undefined" :aria-labelledby="sectionViews.length ? 'settings-view-configuration' : undefined">
            <template v-if="activeTab === 'models'">
              <SettingsGroup title="Main conversation" :status="groupStatus('models-main')" timing="New conversations" description="Choose the default model. Existing conversations keep their current model." data-section="models-main">
                <label class="field-label"><span>Main default model</span><select class="input" aria-label="Main default model" :value="modelValue()" @change="chooseModel(($event.target as HTMLSelectElement).value)"><option value="">Runtime default</option><option v-if="modelValue() && !choices.some(c => c.value === modelValue())" :value="modelValue()">{{ modelValue() }} (saved)</option><option v-for="choice in choices" :key="choice.value" :value="choice.value">{{ choice.label }}</option></select></label>
                <label class="field-label"><span>Main thinking level</span><select class="input" data-setting="thinkingLevel" aria-label="Main thinking level" aria-describedby="main-thinking-help" :value="draft.thinkingLevel ?? ''" @change="setVal(['thinkingLevel'], ($event.target as HTMLSelectElement).value || undefined)"><option value="">Model default</option><option v-for="level in thinkingLevels" :key="level" :value="level">{{ level }}</option></select><small id="main-thinking-help">{{ helpFor(['thinkingLevel']) }}</small></label>
                <details class="advanced-fields"><summary>Provider and model IDs</summary><ComponentField v-for="key in ['provider', 'model']" :key="key" :schema="saved.schema.properties[key]" :path="[key]" :required="(saved.schema.required || []).includes(key)" :get="getVal" :set="setVal" :seed="seedSchema" :label-for="labelFor" :help-for="helpFor" /></details>
              </SettingsGroup>
              <SettingsGroup title="Subagent defaults" :status="groupStatus('models-subagents')" timing="New subagents" :description="summaries.subagents" data-section="models-subagents">
                <label class="field-label"><span>Subagent default model</span><select class="input" aria-label="Subagent default model" :value="modelValue(true)" @change="chooseModel(($event.target as HTMLSelectElement).value, true)"><option value="">Inherit parent model</option><option v-if="modelValue(true) && !choices.some(c => c.value === modelValue(true))" :value="modelValue(true)">{{ modelValue(true) }} (saved)</option><option v-for="choice in choices" :key="choice.value" :value="choice.value">{{ choice.label }}</option></select></label>
                <label class="field-label"><span>Subagent thinking level</span><select class="input" data-setting="subagents.thinkingLevel" aria-label="Subagent thinking level" :value="draft.subagents.thinkingLevel ?? ''" @change="setVal(['subagents', 'thinkingLevel'], ($event.target as HTMLSelectElement).value || undefined)"><option value="">Inherit parent thinking level</option><option v-for="level in thinkingLevels" :key="level" :value="level">{{ level }}</option></select></label>
                <ComponentField :schema="saved.schema.properties.subagents.properties.cwd" :path="['subagents','cwd']" :required="false" :get="getVal" :set="setVal" :seed="seedSchema" :label-for="labelFor" :help-for="helpFor" />
                <details class="advanced-fields"><summary>Provider and model IDs</summary><ComponentField v-for="key in ['provider', 'model']" :key="key" :schema="saved.schema.properties.subagents.properties[key]" :path="['subagents', key]" :required="false" :get="getVal" :set="setVal" :seed="seedSchema" :label-for="labelFor" :help-for="helpFor" /></details>
              </SettingsGroup>
              <SettingsGroup title="Model catalog" :status="groupStatus('models-refresh')" class="full-span" data-section="models-refresh"><div><button class="settings-button" type="button" :disabled="isRefreshingModels" @click="refreshModels"><RefreshCw :size="16" :class="{ 'refresh-spin': isRefreshingModels }" />{{ isRefreshingModels ? 'Refreshing…' : 'Refresh models' }}</button></div><p class="section-description">Refreshes automatically at startup and every hour. Saved model definitions and unsaved settings are kept.</p><p v-if="models.refresh?.checkedAt" class="help">Last checked: {{ new Date(models.refresh.checkedAt).toLocaleString() }}</p><p v-if="modelRefreshMessage" role="status" class="help">{{ modelRefreshMessage }}</p><p v-else-if="models.refresh && Object.keys(models.refresh.errors).length" role="status" class="help">Some providers could not refresh. Existing models are kept. {{ Object.entries(models.refresh.errors).map(([id, error]) => `${id}: ${error}`).join('; ') }}</p></SettingsGroup>
            </template>

            <template v-for="key in section.keys" :key="key">
              <SettingsGroup v-if="activeTab !== 'models' || ['auxiliary', 'providers'].includes(key)" :title="fieldTitles[key] || key" :description="summaries[key]" :status="groupStatus(key)" :timing="timing[key] || 'Restart required'" :data-section="key"><ComponentField :schema="saved.schema.properties[key]" :path="[key]" :required="(saved.schema.required || []).includes(key)" :get="getVal" :set="setVal" :seed="seedSchema" :label-for="labelFor" :help-for="helpFor" /></SettingsGroup>
            </template>
            <SettingsGroup v-if="activeTab === 'system'" title="Configuration file" timing="Read only" class="full-span" data-section="configuration-file"><p class="config-path">{{ saved.path }}</p><p class="section-description">Save settings writes every section to this file. Saved secret markers keep existing credentials unchanged.</p><p v-if="saved.environmentOverrides.length" class="help">Environment overrides: {{ saved.environmentOverrides.join(', ') }}. These values take precedence over saved settings.</p><p v-else class="help">No environment overrides are active.</p></SettingsGroup>
          </fieldset>
        </div>
      </div>
    </div>
    <footer class="settings-footer"><div class="save-state"><strong>{{ dirty ? 'Unsaved changes' : saved?.restartRequired ? 'Restart required' : 'Configuration' }}</strong><p role="status" aria-live="polite" :class="{ 'save-error': saveError }">{{ statusText || 'Settings apply as shown beside each section.' }}</p></div><div class="save-actions"><button class="settings-button" type="button" :disabled="!saved || loading || disabled" @click="reloadSettings">{{ isReloading ? 'Reloading…' : 'Reload' }}</button><button class="settings-button primary" type="button" data-settings-save :disabled="!saved || loading || disabled" @click="saveSettings">{{ isSaving ? 'Saving...' : 'Save settings' }}</button></div></footer>
  </div>
</template>

<style scoped>
.settings-screen { width: 100%; min-width: 0; height: 100%; flex: 1; display: flex; flex-direction: column; background: var(--background); }
.settings-header { display: flex; align-items: center; gap: 16px; padding: 20px 32px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.settings-heading { flex: 1; min-width: 0; }
.settings-heading h1 { font-size: 24px; font-weight: 650; letter-spacing: -.025em; }
.settings-heading p, .section-heading p { color: var(--muted-foreground); font-size: 15px; margin-top: 4px; }
.settings-layout { display: flex; min-height: 0; flex: 1; }
.settings-nav { flex: 0 0 208px; padding: 20px 12px; border-right: 1px solid var(--border); overflow-y: auto; }
.settings-tabs { display: flex; flex-direction: column; gap: 4px; }
.settings-tabs button { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 10px 12px; border-radius: 6px; text-align: left; color: var(--muted-foreground); cursor: pointer; flex-shrink: 0; }
.settings-tabs button:hover { background: var(--accent); color: var(--foreground); }
.settings-tabs button[aria-selected="true"] { background: var(--acc-soft); color: var(--primary); font-weight: 600; }
.settings-tabs svg { flex-shrink: 0; }
.settings-scroll { flex: 1; min-width: 0; overflow-y: auto; overscroll-behavior: contain; }
.settings-content { padding: 28px 32px 40px; min-width: 0; }
.section-heading { margin-bottom: 24px; }
.section-heading h2 { font-size: 21.5px; font-weight: 600; letter-spacing: -.02em; }
.settings-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; align-items: start; min-width: 0; padding: 0; margin: 0; border: 0; }
@media (min-width: 961px) {
  .settings-body {
    grid-template-columns: 320px minmax(0, 1fr);
    grid-template-rows: repeat(8, max-content) 1fr;
    grid-auto-flow: dense;
    column-gap: 32px;
    row-gap: 8px;
  }
  .settings-body:not(:has(> details.settings-card[open] ~ details.settings-card[open])) > details.settings-card[open] > :deep(.group-content) {
    grid-row: 1 / 10;
  }
  .settings-body:not(:has(> details.settings-card[open]))::after {
    content: "Select a setting group on the left to inspect and edit its options.";
    grid-column: 2;
    grid-row: 1 / 10;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 220px;
    padding: 32px;
    border: 1px dashed var(--border);
    border-radius: 10px;
    color: var(--muted-foreground);
    font-size: 14px;
    text-align: center;
  }
}
.section-description, .help { color: var(--muted-foreground); line-height: 1.6; font-size: 14px; max-width: 76ch; }
.settings-subtabs { display: flex; gap: 20px; margin: -8px 0 24px; border-bottom: 1px solid var(--border); overflow-x: auto; min-width: 0; }
.settings-subtabs button { min-height: 44px; padding: 10px 2px; flex-shrink: 0; border-bottom: 2px solid transparent; font-size: 15px; color: var(--muted-foreground); cursor: pointer; white-space: nowrap; }
.settings-subtabs button:hover { color: var(--foreground); }
.settings-subtabs button[aria-selected="true"] { color: var(--primary); border-color: var(--primary); font-weight: 600; }
.settings-management { min-width: 0; }
.manager-description { color: var(--muted-foreground); font-size: 15px; line-height: 1.6; margin-bottom: 16px; }
.manager-notice { border: 1px solid var(--border); border-radius: 6px; padding: 12px 16px; margin-bottom: 20px; font-size: 14px; color: var(--muted-foreground); }
.settings-manager { border: 0; padding: 0; margin: 0; min-width: 0; }
.settings-manager :deep(button:not(.icon-button)) { min-height: 44px; }
.settings-manager :deep(.card:not(details)) { padding: 16px; }
.settings-manager :deep(input:not([type=checkbox])), .settings-manager :deep(select), .settings-manager :deep(textarea) { min-height: 44px; }
.settings-manager :deep(pre) { margin-top: 12px; }
.manager-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 290px), 1fr)); gap: 12px; margin-bottom: 24px; }
.manager-link { display: flex; align-items: flex-start; gap: 16px; padding: 16px 20px; border: 1px solid var(--border); border-radius: 8px; text-align: left; cursor: pointer; min-width: 0; }
.manager-link:hover { background: var(--accent); border-color: var(--muted-foreground); }
.manager-link strong { font-size: 15px; font-weight: 550; }
.manager-link p { font-size: 14px; color: var(--muted-foreground); line-height: 1.55; margin-top: 4px; }
.manager-link div { flex: 1; min-width: 0; }
.manager-link svg { flex-shrink: 0; color: var(--muted-foreground); margin-top: 2px; }
.field-label { display: flex; flex-direction: column; gap: 6px; font-size: 14px; font-weight: 500; min-width: 0; }
.field-label small { font-size: 14px; line-height: 1.55; color: var(--muted-foreground); font-weight: 400; }
.input { width: 100%; min-width: 0; min-height: 40px; padding: 8px 12px; border: 1px solid var(--input); border-radius: 6px; background: var(--background); color: var(--foreground); }
.advanced-fields { border-top: 1px solid var(--border); padding-top: 8px; }
.advanced-fields summary { cursor: pointer; color: var(--muted-foreground); font-size: 14px; padding-block: 8px; }
.advanced-fields[open] summary { margin-bottom: 12px; }
.advanced-fields :deep(.field) { margin-bottom: 16px; }
.settings-footer { flex-shrink: 0; display: flex; align-items: center; gap: 16px; justify-content: space-between; padding: 16px 32px; border-top: 1px solid var(--border); background: var(--background); }
.save-state { min-width: 0; }
.save-state strong { font-size: 14px; font-weight: 550; }
.save-state p { font-size: 13px; line-height: 1.5; color: var(--muted-foreground); margin-top: 4px; overflow-wrap: anywhere; }
.save-state p.save-error { color: var(--destructive); }
.save-actions { display: flex; gap: 8px; flex-shrink: 0; }
.settings-button { display: inline-flex; justify-content: center; align-items: center; gap: 8px; min-height: 44px; padding: 10px 16px; border: 1px solid var(--border); border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer; white-space: nowrap; }
.settings-button:hover { background: var(--accent); }
.settings-button.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
.settings-button.primary:hover { filter: brightness(1.08); }
button:disabled { opacity: .45; cursor: not-allowed; }
.settings-loading, .settings-error { padding: 24px 0; color: var(--muted-foreground); }
.settings-error p { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; color: var(--destructive); }
.config-path { font-family: monospace; font-size: 14px; overflow-wrap: anywhere; }
.mobile-only { display: none; }
.refresh-spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 1000px) and (min-width: 761px) { .settings-nav { flex-basis: 180px; padding-inline: 8px; } .settings-content { padding: 24px; } .settings-tabs button { font-size: 14px; padding-inline: 8px; gap: 8px; } }
@media (max-width: 760px) {
  .settings-header { padding: 12px 16px; gap: 12px; }
  .settings-heading h1 { font-size: 19.5px; }
  .settings-heading p { display: none; }
  .mobile-only { display: inline-flex; width: 44px; height: 44px; }
  .back-button { padding-inline: 12px; }
  .settings-layout { flex-direction: column; }
  .settings-nav { flex: 0 0 auto; width: 100%; padding: 8px 16px; border-right: 0; border-bottom: 1px solid var(--border); overflow: hidden; }
  .settings-tabs { flex-direction: row; overflow-x: auto; gap: 4px; padding: 4px; scroll-padding-inline: 4px; }
  .settings-tabs button { white-space: nowrap; font-size: 14px; }
  .settings-content { padding: 24px 16px 32px; }
  .settings-body { gap: 16px; }
  .settings-footer { padding: 12px 16px; flex-wrap: wrap; gap: 8px; }
  .save-state { width: 100%; }
  .save-state strong { display: none; }
  .save-state p { margin: 0; max-height: 4.5em; overflow-y: auto; }
  .save-actions { width: 100%; justify-content: flex-end; }
  .manager-link { padding: 16px; }
  .input { font-size: 16.5px; min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) { .refresh-spin { animation: none; } }
</style>
