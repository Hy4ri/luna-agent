<script setup lang="ts">
import { computed, ref, provide, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { ui, setSettingsGuard, setDrawer, navigate, openPanel, setSettingsTab, settingsChanged } from '@/stores/app'
import { scheduleContext } from '@/stores/chat'
import { loadModels, modelIndex, models, refreshCatalog } from '@/stores/models'
import { json, post } from '@/lib/api'
import { useMobile } from '@/lib/dom'
import ConnectionRoutes from '@/components/ConnectionRoutes.vue'
import ModelCombobox from '@/components/ModelCombobox.vue'
import ComponentField from './settings/ComponentField.vue'
import SettingsGroup from './settings/SettingsGroup.vue'
import SettingsSearch from './settings/SettingsSearch.vue'
import type { SettingsResult } from './settings/settingsSearch'
import { PANELS } from '@/components/panels'
import { sections, fieldTitles, labelFor, helpFor, summaries, timing, managers, groupFor, assertCatalogCoverage, settingRoute } from './settings/catalog'
import { Menu, X, ArrowLeft, ArrowUpRight, MessageSquare, Network, Plug, BookOpen, Image, Wrench, Clock, Settings2, AlertCircle, RefreshCw } from '@lucide/vue'

const mobile = useMobile()
const icons = [MessageSquare, Network, Plug, Wrench, BookOpen, Image, Clock, Settings2]
const mobileIndex = ref(mobile.value && ui.settingsIndex)
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
const activeTab = computed(() => sections.some(s => s.id === ui.settingsTab) ? ui.settingsTab : 'chat')
const section = computed(() => sections.find(s => s.id === activeTab.value)!)
const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== baseline.value)
const managerBusy = ref(false)
const pendingForms = ref(new Set<string>())
const pendingFormReload = ref(false)
provide('settingsPendingForms', pendingForms)
watch(() => pendingForms.value.size, count => { if (!count && pendingFormReload.value && !dirty.value) { pendingFormReload.value = false; void loadSettings({ background: true }) } })
const related = computed(() => managers[activeTab.value] || [])
const disabled = computed(() => isSaving.value || isReloading.value || managerBusy.value || managerReloading.value)
const managerReloading = ref(false)
async function managerChanged() {
  if (pendingForms.value.size) { pendingFormReload.value = true; return }
  // Managers are disabled while the draft is dirty. Block stale saves until the new revision is loaded.
  managerReloading.value = true
  // Reload in the background: a full loading state unmounts the manager panels and drops their live state (an OAuth login in progress).
  try { await loadSettings({ background: true }) } finally { managerReloading.value = false }
}
function selectSearch(result: SettingsResult) {
  if (disabled.value) return
  if (result.panel) openRelated(result.panel)
  else { setSettingsTab(result.route); mobileIndex.value = false; void revealTarget() }
}
function openRelated(id: string) {
  if (!disabled.value && !loading.value) openPanel(id, { keepSettings: true })
}
const thinkingLevels = computed<string[]>(() => saved.value?.schema.properties.thinkingLevel.enum || [])
// Only draft custom-provider models that /v1/models does not list yet. Pickers read catalog models from the store,
// so copying a catalog of thousands of models here would re-merge it in every picker.
const choices = computed(() => {
  const result = new Map<string, string>()
  const catalog = modelIndex.value
  for (const p of draft.value?.providers || []) for (const m of p.models || []) {
    const key = `${p.id}/${m.id}`
    if (p.id && m.id && !catalog.has(key)) result.set(key, `${p.name || p.id} · ${m.name || m.id}`)
  }
  return [...result].map(([value, label]) => ({ value, label }))
})
provide('settingsModelChoices', choices)
provide('settingsDraft', draft)
provide('settingsOverrides', computed<string[]>(() => saved.value?.environmentOverrides || []))
provide('settingsDisabled', disabled)
function groupStatus(key: string): string {
  const value = draft.value?.[key]
  if (key === 'models-main') return modelValue() || 'Runtime default'
  if (key === 'models-subagents') return modelValue(true) || 'Inherit parent model'
  if (key === 'models-refresh') return `${models.list.length} models available`
  if (key === 'modelThinkingLevels') return Object.keys(value || {}).length ? `${Object.keys(value).length} model overrides` : 'Main level for every model'
  if (Array.isArray(value)) return `${value.length} ${key === 'extensions' ? 'enabled' : 'configured'}`
  if (key === 'busyInput') return `${value?.mode || 'steer'} mode`
  if (key === 'vision') return value?.image_mode === 'auxiliary' ? 'Auxiliary model' : 'Active model'
  if (key === 'image_gen') return value?.provider || 'No provider selected'
  if (key === 'auxiliary') return `${Object.values(value || {}).filter(Boolean).length} model overrides`
  if (key === 'web') return `${value?.searchProvider === 'disabled' ? 'Search off' : 'DDGS search'} · ${value?.extractProvider === 'disabled' ? 'extraction off' : 'DDGS extraction'}`
  if (key === 'browser') return value?.provider === 'disabled' ? 'Disabled' : value?.provider || 'Disabled'
  if (key === 'server') return `${value?.host}:${value?.port}`
  if (key === 'cron') return value?.runTimeoutMinutes ? `${value.runTimeoutMinutes} minute limit` : 'No run time limit'
  if (key === 'steward') return value?.enabled === false ? 'Off' : `Check every ${value?.detectEveryMinutes} minutes`
  if (key === 'improve') return value?.allowCommandBenchmarks ? 'Command benchmarks allowed' : 'Command benchmarks off'
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
const perModelLevels = computed<[string, string][]>(() => Object.entries(draft.value?.modelThinkingLevels || {}) as [string, string][])
function modelChoiceLabel(key: string) { return choices.value.find(choice => choice.value === key)?.label || key }
function setModelLevel(model: string, level?: string) {
  const next = { ...(draft.value?.modelThinkingLevels || {}) }
  if (level) next[model] = level
  else delete next[model]
  setVal(['modelThinkingLevels'], Object.keys(next).length ? next : undefined)
}
function addModelLevel(model: string) {
  if (!model || draft.value?.modelThinkingLevels?.[model]) return
  setModelLevel(model, 'medium')
}
async function selectTab(id: string, focus = false) {
  if (disabled.value || loading.value) return
  setSettingsTab(id)
  mobileIndex.value = false
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
watch(() => ui.settingsNavigation, () => { mobileIndex.value = mobile.value && ui.settingsIndex })
async function revealTarget() {
  if (loading.value || !saved.value) return
  if (!ui.settingsTarget) return
  mobileIndex.value = false
  await nextTick()
  const [group, ...parts] = ui.settingsTarget.split('.')
  const sectionEl = [...(content.value?.querySelectorAll<HTMLElement>('[data-section]') || [])].find(el => el.dataset.section === group)
  if (!sectionEl) return
  const key = section.value.keys.find(key => groupFor(key) === group)
  const path = ['main-model'].includes(group!) ? parts.join('.') : [key, ...parts].filter(Boolean).join('.')
  const controls = [...sectionEl.querySelectorAll<HTMLElement>('[data-setting]')]
  let target = controls.find(el => el.dataset.setting === path)
  // Optional model overrides have one chooser until a model is selected.
  target ||= controls.filter(el => path.startsWith((el.dataset.setting || '') + '.')).sort((a, b) => (b.dataset.setting?.length || 0) - (a.dataset.setting?.length || 0))[0]
  if (target) {
    for (let parent = target.parentElement; parent && parent !== sectionEl; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true
  }
  target ||= sectionEl.querySelector<HTMLElement>('input, select, textarea, button, h3') || sectionEl
  target.scrollIntoView({ block: 'center', behavior: 'instant' })
  target.focus({ preventScroll: true })
}
watch([() => ui.settingsNavigation, loading], () => { void revealTarget() }, { flush: 'post' })
let mounted = true
async function loadSettings(options: { background?: boolean } = {}) {
  const background = options.background && !!saved.value
  if (!background) { loading.value = true; loadError.value = null }
  try {
    const [res] = await Promise.all([json('/v1/settings'), loadModels()])
    if (!mounted) return
    assertCatalogCoverage(res.schema)
    saved.value = res
    draft.value = structuredClone(res.config)
    baseline.value = JSON.stringify(draft.value)
    saveError.value = false
    statusText.value = res.restartRequired ? 'Saved startup settings need a Luna restart.' : 'No unsaved changes.'
  } catch (e: any) {
    if (!mounted) return
    if (background) { saveError.value = true; statusText.value = 'Could not reload settings: ' + (e.message || 'request failed') }
    else loadError.value = e.message || 'Failed to load settings'
  } finally {
    if (mounted && !background) loading.value = false
  }
}
async function saveSettings() {
  const form = content.value?.querySelector<HTMLFieldSetElement>('#settings-configuration')
  const invalid = form?.querySelector<HTMLInputElement>('input:invalid, select:invalid, textarea:invalid')
  if (invalid) {
    for (let parent = invalid.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true
    invalid.reportValidity(); invalid.focus(); return
  }
  if (disabled.value || loading.value || !dirty.value || !saved.value) return
  isSaving.value = true
  saveError.value = false
  try {
    const res = await post('/v1/settings', { config: draft.value, revision: saved.value.revision }, 'PUT')
    if (!mounted) return
    saved.value = res
    draft.value = structuredClone(res.config)
    baseline.value = JSON.stringify(draft.value)
    await loadModels({ force: true })
    scheduleContext()
    const warn = (res.warnings || []).join(' ')
    statusText.value = (res.restartRequired ? 'Saved. Applied live except startup settings: restart Luna to apply those.' : 'Settings saved and applied. New sessions and subagents use the new defaults.') + (warn ? ' ' + warn : '')
    saveError.value = !!warn
  } catch (e: any) {
    statusText.value = e.message || 'Failed to save settings'
    saveError.value = true
    try {
      const issues = JSON.parse(e.message)
      const path = issues.find((issue: any) => Array.isArray(issue.path) && issue.path.length)?.path
      if (path) { isSaving.value = false; setSettingsTab(settingRoute(path)); await revealTarget() }
    } catch { /* Non-schema errors remain visible in the save status. */ }
  } finally { isSaving.value = false }
}
async function reloadSettings() {
  if (disabled.value || (dirty.value && !confirm('Discard unsaved edits and reload settings?'))) return
  isReloading.value = true
  try { await loadSettings() } finally { isReloading.value = false }
}
async function refreshModels() {
  if (isRefreshingModels.value) return
  isRefreshingModels.value = true
  modelRefreshMessage.value = ''
  try {
    const result = await refreshCatalog()
    const errors = Object.entries(result.errors).map(([id, message]) => `${id}: ${message}`)
    if (!result.ok) modelRefreshMessage.value = `${result.error || 'Model refresh failed.'} Existing models are kept.`
    else modelRefreshMessage.value = errors.length ? `Refresh incomplete. ${errors.join('; ')}` : 'Model catalog refreshed.'
  } finally { isRefreshingModels.value = false }
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
  statusText.value = dirty.value ? 'Unsaved changes.' : saved.value?.restartRequired ? 'Saved startup settings need a Luna restart.' : 'No unsaved changes.'
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
  setSettingsGuard({ canLeave: () => !disabled.value && ((!dirty.value && !pendingForms.value.size) || confirm('Discard unsaved settings and connection edits?')), isDirty: () => dirty.value || !!pendingForms.value.size || disabled.value, canChangeTab: () => !disabled.value && (!pendingForms.value.size || confirm('Discard unsaved connection definition edits?')) })
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
      <div class="settings-heading"><h1>Settings</h1><p>Find a setting and make Luna work the way you do.</p></div>
      <button class="icon-button" type="button" data-settings-close aria-label="Close settings" :disabled="disabled" @click="navigate('chat')"><X :size="18" /></button>
    </header>
    <SettingsSearch :schema="saved?.schema" :config="draft" :disabled="disabled || loading || !!loadError" @select="selectSearch" />
    <div class="settings-layout">
      <nav v-show="!mobile || mobileIndex" class="settings-nav" aria-label="Settings categories">
        <div class="settings-tabs">
          <button v-for="(item, index) in sections" :id="'settings-tab-' + item.id" :key="item.id" type="button" :data-settings-tab="item.id" :aria-current="!mobileIndex && activeTab === item.id ? 'page' : undefined" :disabled="disabled || loading" @click="selectTab(item.id)" @keydown="moveTab($event, index)"><component :is="icons[index]" :size="18" /><span><strong>{{ item.title }}</strong><small v-if="mobile">{{ item.description }}</small></span></button>
        </div>
      </nav>
      <div v-show="!mobile || !mobileIndex" ref="content" class="settings-scroll">
        <div id="settings-fields" class="settings-content" tabindex="-1">
          <button v-if="mobile" type="button" class="settings-button index-back" :disabled="disabled" @click="mobileIndex = true"><ArrowLeft :size="16" />All settings</button>
          <div class="section-heading"><h2 tabindex="-1" id="settings-category-title">{{ section.title }}</h2><p>{{ section.description }}</p></div>
          <ConnectionRoutes v-if="activeTab === 'system'" :disabled="disabled || dirty || pendingForms.size > 0" />
          <div v-if="loading" class="settings-loading" role="status">Loading settings…</div>
          <div v-else-if="loadError" class="settings-error"><p role="alert"><AlertCircle :size="18" />{{ loadError }}</p><button class="settings-button" type="button" @click="loadSettings()">Retry</button></div>
          <template v-else-if="saved && draft">
            <p class="manager-notice">{{ activeTab === 'connections' ? 'Account and connection actions apply immediately. They do not use Save settings.' : 'Preference edits use Save settings. Changes from every category share one draft.' }}</p>
            <div v-if="related.length" class="manager-grid" aria-label="Related management panels">
              <button v-for="manager in related" :key="manager.id" type="button" class="manager-link" :data-panel="manager.id" :disabled="disabled" @click="openRelated(manager.id)"><div><strong>{{ manager.title }}</strong><p>{{ manager.description }}</p></div><ArrowUpRight :size="18" /></button>
            </div>
            <template v-if="activeTab === 'connections'">
              <p v-if="dirty" class="manager-notice" role="status">Save or discard preference edits before changing accounts or connections. Your draft is kept.</p>
              <section v-for="manager in [{ id: 'providers', title: 'Provider accounts' }, { id: 'mcp', title: 'MCP connections' }]" :key="manager.id" :data-section="manager.id" class="settings-management">
                <h3 tabindex="-1">{{ manager.title }}</h3>
                <fieldset class="settings-manager" :disabled="isSaving || isReloading || dirty || managerReloading || !!loadError">
                  <component :is="PANELS[manager.id]?.component" @busy="managerBusy = $event" @changed="managerChanged" />
                </fieldset>
              </section>
            </template>
            <fieldset v-else id="settings-configuration" class="settings-body" :disabled="disabled" aria-label="Preference settings">
            <template v-if="activeTab === 'models'">
              <SettingsGroup title="Main conversation" :status="groupStatus('models-main')" timing="New conversations" description="Choose the default model. Existing conversations keep their current model." data-section="main-model">
                <label class="field-label"><span>Main default model</span><ModelCombobox :model-value="modelValue() || undefined" placeholder="Search models…" empty-label="Runtime default" aria-label="Main default model" data-setting="model" @change="chooseModel($event || '')" /></label>
                <label class="field-label"><span>Main thinking level</span><select class="input" data-setting="thinkingLevel" aria-label="Main thinking level" aria-describedby="main-thinking-help" :value="draft.thinkingLevel ?? ''" @change="setVal(['thinkingLevel'], ($event.target as HTMLSelectElement).value || undefined)"><option value="">Model default</option><option v-for="level in thinkingLevels" :key="level" :value="level">{{ level }}</option></select><small id="main-thinking-help">{{ helpFor(['thinkingLevel']) }}</small></label>
                <details class="advanced-fields"><summary>Provider and model IDs</summary><ComponentField v-for="key in ['provider', 'model']" :key="key" :schema="saved.schema.properties[key]" :path="[key]" :required="(saved.schema.required || []).includes(key)" :get="getVal" :set="setVal" :seed="seedSchema" :label-for="labelFor" :help-for="helpFor" /></details>
              </SettingsGroup>
              <SettingsGroup title="Subagent defaults" :status="groupStatus('models-subagents')" timing="New subagents" :description="summaries.subagents" data-section="subagents">
                <label class="field-label"><span>Subagent default model</span><ModelCombobox :model-value="modelValue(true) || undefined" placeholder="Search models…" empty-label="Inherit parent model" aria-label="Subagent default model" data-setting="subagents.model" @change="chooseModel($event || '', true)" /></label>
                <label class="field-label"><span>Subagent thinking level</span><select class="input" data-setting="subagents.thinkingLevel" aria-label="Subagent thinking level" :value="draft.subagents.thinkingLevel ?? ''" @change="setVal(['subagents', 'thinkingLevel'], ($event.target as HTMLSelectElement).value || undefined)"><option value="">Inherit parent thinking level</option><option v-for="level in thinkingLevels" :key="level" :value="level">{{ level }}</option></select></label>
                <ComponentField :schema="saved.schema.properties.subagents.properties.cwd" :path="['subagents','cwd']" :required="false" :get="getVal" :set="setVal" :seed="seedSchema" :label-for="labelFor" :help-for="helpFor" />
                <details class="advanced-fields"><summary>Provider and model IDs</summary><ComponentField v-for="key in ['provider', 'model']" :key="key" :schema="saved.schema.properties.subagents.properties[key]" :path="['subagents', key]" :required="false" :get="getVal" :set="setVal" :seed="seedSchema" :label-for="labelFor" :help-for="helpFor" /></details>
              </SettingsGroup>
              <SettingsGroup title="Per-model thinking levels" :status="groupStatus('modelThinkingLevels')" timing="New conversations" :description="summaries.modelThinkingLevels" data-section="modelThinkingLevels">
                <div v-if="perModelLevels.length" class="model-level-list">
                  <div v-for="[model, level] in perModelLevels" :key="model" class="model-level-row">
                    <span class="model-level-name">{{ modelChoiceLabel(model) }}</span>
                    <select class="input" :value="level" :data-setting="'modelThinkingLevels.' + model" :aria-label="'Thinking level for ' + modelChoiceLabel(model)" @change="setModelLevel(model, ($event.target as HTMLSelectElement).value)"><option v-for="option in thinkingLevels" :key="option" :value="option">{{ option }}</option></select>
                    <button class="settings-button" type="button" :aria-label="'Remove thinking level for ' + modelChoiceLabel(model)" @click="setModelLevel(model, undefined)">Remove</button>
                  </div>
                </div>
                <p v-else class="help">Every model uses the main thinking level.</p>
                <label class="field-label"><span>Add a model</span><ModelCombobox :model-value="undefined" placeholder="Search models…" empty-label="Choose a model" aria-label="Add per-model thinking level" @change="addModelLevel($event || '')" /><small>{{ helpFor(['modelThinkingLevels']) }}</small></label>
              </SettingsGroup>
              <SettingsGroup title="Model catalog" :status="groupStatus('models-refresh')" class="full-span" data-section="catalog"><div><button class="settings-button" type="button" :disabled="isRefreshingModels" @click="refreshModels"><RefreshCw :size="16" :class="{ 'refresh-spin': isRefreshingModels }" />{{ isRefreshingModels ? 'Refreshing…' : 'Refresh models' }}</button></div><p class="section-description">Refreshes automatically at startup and every hour. Saved model definitions and unsaved settings are kept.</p><p v-if="models.refresh?.checkedAt" class="help">Last checked: {{ new Date(models.refresh.checkedAt).toLocaleString() }}</p><p v-if="modelRefreshMessage" role="status" class="help">{{ modelRefreshMessage }}</p><p v-else-if="models.refresh && Object.keys(models.refresh.errors).length" role="status" class="help">Some providers could not refresh. Existing models are kept. {{ Object.entries(models.refresh.errors).map(([id, error]) => `${id}: ${error}`).join('; ') }}</p></SettingsGroup>
            </template>
              <template v-for="key in section.keys" :key="key">
                <SettingsGroup v-if="activeTab !== 'models' || key === 'auxiliary'" :title="fieldTitles[key] || key" :description="summaries[key]" :status="groupStatus(key)" :timing="timing[key] || 'Applies live'" :data-section="groupFor(key)">
                  <ComponentField :schema="saved.schema.properties[key]" :path="[key]" :required="(saved.schema.required || []).includes(key)" :get="getVal" :set="setVal" :seed="seedSchema" :label-for="labelFor" :help-for="helpFor" />
                </SettingsGroup>
              </template>
              <SettingsGroup v-if="activeTab === 'media'" title="Analysis models" data-section="analysis-models"><p class="section-description">Choose image and video models in Models → Task-specific models.</p><button class="settings-button" type="button" @click="setSettingsTab('models/task-models')">Choose analysis models<ArrowUpRight :size="16" /></button></SettingsGroup>
              <SettingsGroup v-if="activeTab === 'system'" title="Configuration file" timing="Read only" data-section="configuration-file"><p class="config-path">{{ saved.path }}</p><p class="section-description">Save settings writes every category to this file. Saved secret markers keep existing credentials unchanged.</p><p v-if="saved.environmentOverrides.length" class="help">Environment overrides: {{ saved.environmentOverrides.join(', ') }}. These values take precedence over saved settings.</p><p v-else class="help">No environment overrides are active.</p></SettingsGroup>
            </fieldset>
          </template>
        </div>
      </div>
    </div>
    <footer class="settings-footer"><div class="save-state" :class="{ 'has-alert': dirty || saved?.restartRequired }"><strong>{{ dirty ? 'Unsaved changes' : saved?.restartRequired ? 'Restart required' : 'Settings' }}</strong><p role="status" aria-live="polite" :class="{ 'save-error': saveError }">{{ statusText || 'Settings apply as shown beside each group.' }}</p></div><div class="save-actions"><button class="settings-button" type="button" :disabled="!saved || loading || disabled" @click="reloadSettings">{{ isReloading ? 'Reloading…' : dirty ? 'Discard changes' : 'Reload' }}</button><button class="settings-button primary" type="button" data-settings-save :disabled="!saved || loading || disabled || !dirty" @click="saveSettings">{{ isSaving ? 'Saving...' : 'Save settings' }}</button></div></footer>
  </div>
</template>

<style scoped>
.settings-screen { width: 100%; min-width: 0; height: 100%; flex: 1; display: flex; flex-direction: column; background: var(--background); }
.settings-header { display: flex; align-items: center; gap: 12px; padding: 12px 24px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.settings-heading { flex: 1; min-width: 0; }
.settings-heading h1 { font-size: 18px; font-weight: 600; letter-spacing: -.02em; line-height: 1.25; }
.settings-heading p, .section-heading p { color: var(--muted-foreground); font-size: 12px; margin-top: 2px; }
.settings-layout { display: flex; min-height: 0; flex: 1; overflow: hidden; }
.settings-nav { flex: 0 0 208px; padding: 16px 12px; border-right: 1px solid var(--border); overflow-y: auto; }
.settings-tabs { display: flex; flex-direction: column; gap: 4px; }
.settings-tabs button strong { font-weight: inherit; }
.settings-tabs button small { display: block; font-size: 13px; margin-top: 4px; color: var(--muted-foreground); line-height: 1.5; }
.index-back { margin-bottom: 20px; }
.settings-management { padding-block: 20px; border-top: 1px solid var(--border); }
.settings-management h3 { font-size: 15px; font-weight: 600; margin-bottom: 12px; }
.settings-tabs button { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 10px 12px; border-radius: var(--radius); text-align: left; color: var(--sidebar-foreground); cursor: pointer; flex-shrink: 0; }
.settings-tabs button:hover { background: var(--accent); color: var(--foreground); }
.settings-tabs button[aria-current="page"] { background: var(--acc-soft); color: var(--primary-text); font-weight: 600; }
.settings-tabs button:focus-visible, .manager-link:focus-visible, .settings-button:focus-visible, .icon-button:focus-visible, .advanced-fields summary:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.settings-tabs svg { flex-shrink: 0; }
.settings-scroll { flex: 1; min-width: 0; overflow-y: auto; overscroll-behavior: contain; }
.settings-content { padding: 20px 24px 48px; min-width: 0; max-width: 1040px; margin-inline: auto; }
.section-heading { margin-bottom: 20px; }
.section-heading h2 { font-size: 16px; font-weight: 600; letter-spacing: -.015em; }
.section-heading p { font-size: 13px; margin-top: 4px; }
.settings-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; align-items: start; min-width: 0; padding: 0; margin: 0; border: 0; }
.section-description, .help { color: var(--muted-foreground); line-height: 1.6; font-size: 14px; max-width: 76ch; }
.settings-management { min-width: 0; }
.manager-description { color: var(--muted-foreground); font-size: 15px; line-height: 1.6; margin-bottom: 16px; }
.manager-notice { border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 16px; margin-bottom: 20px; font-size: 14px; color: var(--muted-foreground); }
.settings-manager { border: 0; padding: 0; margin: 0; min-width: 0; }
.settings-manager :deep(button:not(.icon-button)) { min-height: 44px; }
.settings-manager :deep(.card:not(details)) { padding: 16px; }
.settings-manager :deep(input:not([type=checkbox])), .settings-manager :deep(select), .settings-manager :deep(textarea) { min-height: 44px; }
.settings-manager :deep(pre) { margin-top: 12px; }
.manager-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 290px), 1fr)); gap: 12px; margin-bottom: 24px; }
.manager-link { display: flex; align-items: flex-start; gap: 16px; padding: 16px 20px; border: 1px solid var(--border); border-radius: var(--radius); text-align: left; cursor: pointer; min-width: 0; }
.manager-link:hover { background: var(--accent); border-color: var(--muted-foreground); }
.manager-link strong { font-size: 15px; font-weight: 550; }
.manager-link p { font-size: 14px; color: var(--muted-foreground); line-height: 1.55; margin-top: 4px; }
.manager-link div { flex: 1; min-width: 0; }
.manager-link svg { flex-shrink: 0; color: var(--muted-foreground); margin-top: 2px; }
.field-label { display: flex; flex-direction: column; gap: 6px; font-size: 14px; font-weight: 500; min-width: 0; }
.field-label small { font-size: 14px; line-height: 1.55; color: var(--muted-foreground); font-weight: 400; }
.input { width: 100%; min-width: 0; min-height: 40px; padding: 8px 12px; border: 1px solid var(--input); border-radius: var(--radius); background: var(--background); color: var(--foreground); }
.model-level-list { display: grid; gap: 8px; }
.model-level-row { display: grid; grid-template-columns: minmax(0, 1fr) 9rem auto; align-items: center; gap: 8px; }
.model-level-name { font-size: 14px; overflow-wrap: anywhere; }
.advanced-fields { border-top: 1px solid var(--border); padding-top: 8px; }
.advanced-fields summary { cursor: pointer; color: var(--muted-foreground); font-size: 14px; padding-block: 8px; }
.advanced-fields[open] summary { margin-bottom: 12px; }
.advanced-fields :deep(.field) { margin-bottom: 16px; }
.settings-footer { flex-shrink: 0; display: flex; align-items: center; gap: 16px; justify-content: space-between; padding: 12px 24px; border-top: 1px solid var(--border); background: var(--background); }
.save-state { min-width: 0; }
.save-state strong { font-size: 14px; font-weight: 550; }
.save-state p { font-size: 13px; line-height: 1.5; color: var(--muted-foreground); margin-top: 4px; overflow-wrap: anywhere; }
.save-state p.save-error { color: var(--destructive); }
.save-actions { display: flex; gap: 8px; flex-shrink: 0; }
.settings-button { display: inline-flex; justify-content: center; align-items: center; gap: 8px; min-height: 44px; padding: 10px 16px; border: 1px solid var(--border); border-radius: var(--radius); font-size: 14px; font-weight: 500; cursor: pointer; white-space: nowrap; }
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
  .settings-heading h1 { font-size: 18px; }
  .settings-heading p { display: none; }
  .mobile-only { display: inline-flex; width: 44px; height: 44px; }
  [data-settings-close] { min-width: 44px; min-height: 44px; }
  .back-button { padding-inline: 12px; }
  .settings-layout { flex-direction: column; min-height: 0; }
  .settings-nav { flex: 1; min-height: 0; width: 100%; padding: 16px 16px 32px; border: 0; overflow-y: auto; }
  .settings-scroll { min-height: 0; }
  .settings-tabs { flex-direction: column; gap: 8px; }
  .settings-tabs button { white-space: normal; font-size: 15px; border: 1px solid var(--border); align-items: flex-start; padding: 16px; }
  .settings-content { padding: 24px 16px 48px; }
  .settings-body { gap: 16px; }
  .advanced-fields summary { min-height: 44px; display: flex; align-items: center; }
  .settings-footer { padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); flex-wrap: wrap; gap: 8px; }
  .save-state { width: 100%; }
  .save-state:not(.has-alert) strong { display: none; }
  .save-state p { margin: 0; max-height: 4.5em; overflow-y: auto; }
  .save-actions { width: 100%; justify-content: flex-end; }
  .manager-link { padding: 16px; }
  .model-level-row { grid-template-columns: minmax(0, 1fr) auto; }
  .model-level-name { grid-column: 1 / -1; }
  .input { font-size: 16px; min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) { .refresh-spin { animation: none; } }
</style>
