<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { ui, setSettingsGuard, openPanel, setDrawer, navigate, setSettingsTab } from '@/stores/app'
import { scheduleContext } from '@/stores/chat'
import { loadModels, models } from '@/stores/models'
function getModels() { return models.list }
import { json, post } from '@/lib/api'
import ComponentField from './settings/ComponentField.vue'
import { Menu, ArrowLeft, ChevronRight, Bot, BarChart2, Wrench, Database, Network, Terminal, AlertCircle, GraduationCap } from '@lucide/vue'

const saved = ref<any>(null)
const draft = ref<any>(null)
const baseline = ref<string>('')
const loading = ref(true)
const loadError = ref<string | null>(null)
const statusText = ref('')
const isSaving = ref(false)
const isReloading = ref(false)
const isRefreshingModels = ref(false)
const modelRefreshMessage = ref('')
async function refreshModels() {
  if (isRefreshingModels.value) return
  isRefreshingModels.value = true
  modelRefreshMessage.value = ''
  try {
    const result = await post('/v1/models/refresh')
    if (!await loadModels()) throw new Error('Refresh finished, but the updated catalog could not be loaded. Try again.')
    const errors = Object.entries(result.refresh.errors).map(([id, message]) => `${id}: ${message}`)
    modelRefreshMessage.value = errors.length ? `Refresh incomplete. ${errors.join('; ')}` : 'Model catalog refreshed.'
  } catch (error: any) {
    modelRefreshMessage.value = error.message || 'Model refresh failed. Existing models are kept.'
  } finally {
    isRefreshingModels.value = false
  }
}

const groups: Record<string, string[]> = {
  general: ["dataDir", "cwd", "server", "busyInput"],
  models: ["provider", "model", "thinkingLevel", "subagents", "providers", "auxiliary"],
  context: ["instructions", "compaction"],
  tools: ["web", "browser", "processes", "mcpServers", "extensions", "skillDirs"],
  automation: ["autoContinue", "cron", "improve", "learn"],
  workspace: [],
}

const tabNames: Record<string, string> = {
  general: "General",
  models: "Models",
  context: "Context",
  tools: "Tools",
  automation: "Automation",
  workspace: "Workspace"
}

const activeTab = ref<string>(ui.settingsTab || "general")
watch(() => ui.settingsTab, id => { activeTab.value = groups[id] ? id : "general" })

function selectTab(id: string, notify = true) {
  if (!groups[id]) id = "general"
  activeTab.value = id
  setSettingsTab(id)
  if (notify) {
    if (id === "workspace") {
      history.replaceState(null, "", "#settings/workspace")
    } else {
      history.replaceState(null, "", `#settings/${id}`)
    }
  }
}

async function loadSettings() {
  loading.value = true
  loadError.value = null
  try {
    await loadModels()
    const res = await json("/v1/settings")
    saved.value = res
    draft.value = JSON.parse(JSON.stringify(res.config))
    baseline.value = JSON.stringify(draft.value)
    notice()
  } catch (e: any) {
    loadError.value = e.message || "Failed to load settings"
  } finally {
    loading.value = false
  }
}

function notice() {
  if (!saved.value) return
  statusText.value = saved.value.restartRequired
    ? "Saved. Restart Luna to apply runtime changes."
    : "Compaction changes apply live. Model defaults apply to new sessions and subagents. Other changes need a restart."
}

async function saveSettings() {
  isSaving.value = true
  try {
    const res = await post("/v1/settings", { config: draft.value, revision: saved.value.revision }, "PUT")
    saved.value = res
    draft.value = JSON.parse(JSON.stringify(res.config))
    baseline.value = JSON.stringify(draft.value)
    await loadModels()
    scheduleContext()
    statusText.value = saved.value.restartRequired ? "Saved. Restart Luna to apply runtime changes." : "Settings saved. Compaction changes apply now. New sessions and subagents use the new defaults."
  } catch (e: any) {
    statusText.value = e.message || "Failed to save settings"
  } finally {
    isSaving.value = false
  }
}

async function reloadSettings() {
  if (!confirm("Discard unsaved edits and reload settings?")) return
  isReloading.value = true
  try {
    await loadSettings()
  } catch (e: any) {
    statusText.value = e.message
  } finally {
    isReloading.value = false
  }
}

function getVal(path: (string | number)[]) {
  let target = draft.value
  for (const key of path) {
    if (target == null) return undefined
    target = target[key]
  }
  return target
}

function setVal(path: (string | number)[], value: any) {
  let target = draft.value
  for (const key of path.slice(0, -1)) {
    if (target[key] == null) target[key] = {}
    target = target[key]
  }
  const lastKey = path[path.length - 1]
  if (value === undefined) {
    delete target[lastKey]
  } else {
    target[lastKey] = value
  }
  statusText.value = "Unsaved changes."
}

const titles: Record<string, string> = {
  auxiliary: "Auxiliary models", side_question: "Side questions", session_title: "Session titles",
  browser: "Browser tools", camofox: "Camofox",
  processes: "Background processes", retentionHours: "Completed output retention (hours)", maxOutputBytes: "Retained output per process (bytes)",
  web: "Web tools", searchProvider: "Search provider", extractProvider: "Extraction provider", ddgs: "DDGS", mcpServer: "MCP server name", backend: "Search backend", region: "Search region", safesearch: "Safe search",
  dataDir: "Data directory", cwd: "Working directory", provider: "Provider", model: "Model ID",
  thinkingLevel: "Thinking level", instructions: "Default instructions", providers: "Custom AI providers",
  subagents: "Subagents", extensions: "Extensions", skillDirs: "Extra skill directories", mcpServers: "MCP servers",
  cron: "Scheduled runs", improve: "Self-improvement", learn: "Session learning", idleMinutes: "Idle time before a scan (minutes)", server: "HTTP server", notifyUrl: "Notification URL",
  runTimeoutMinutes: "Run timeout (minutes)", schedule: "Schedule (cron expression)", allowCommandBenchmarks: "Allow command benchmarks",
  host: "Host", port: "Port", id: "ID", name: "Name", api: "API format", baseUrl: "Base URL", models: "Models",
  contextWindow: "Context window (tokens)", maxTokens: "Maximum output tokens", reasoning: "Reasoning support", vision: "Image support",
  transport: "Transport", command: "Command", args: "Arguments", env: "Environment variables", url: "URL", headers: "Headers",
  busyInput: "Busy chat input", mode: "Mode", acknowledgements: "Show acknowledgements",
  compaction: "Automatic compaction", triggerPercent: "Context trigger (%)",
  autoContinue: "Continue after usage limits", maxWaitHours: "Longest wait for a reset (hours)", maxAttempts: "Attempts in a row",
  enabled: "Enabled", defer: "Defer tools until search", timeoutMs: "Tool-call timeout (milliseconds)",
}

const additions: Record<string, string> = {
  providers: "provider", models: "model", mcpServers: "MCP server", skillDirs: "skill directory",
  args: "argument", env: "environment variable", headers: "header"
}

function labelFor(path: (string | number)[]): string {
  const last = path[path.length - 1]
  const secondLast = path[path.length - 2]
  const joined = path.join(".")
  if (joined === "web.providers" || joined === "browser.providers") return "Provider options"
  if (joined === "processes.enabled") return "Enable background command starts"
  if (joined === "browser.provider") return "Browser provider"
  if (joined === "compaction.enabled") return "Enable automatic compaction"
  if (joined === "autoContinue.enabled") return "Continue automatically when a usage limit resets"
  if (typeof last === "number") {
    return (additions[String(secondLast)] || "Item") + " " + (Number(last) + 1)
  }
  if (joined === "thinkingLevel") return "Main thinking level"
  if (joined === "subagents.thinkingLevel") return "Subagent thinking level"
  return titles[String(last)] || String(last)
}

function seedSchema(schema: any): any {
  if (schema.default !== undefined) return JSON.parse(JSON.stringify(schema.default))
  const variants = schema.anyOf || schema.oneOf
  if (variants) return seedSchema(variants.find((s: any) => s.properties?.transport?.const === "http") || variants[0])
  if (schema.const !== undefined) return schema.const
  if (schema.enum) return schema.enum[0]
  if (schema.type === "array") return []
  if (schema.type === "object") {
    const result: any = {}
    for (const key of schema.required || []) {
      result[key] = seedSchema(schema.properties[key])
    }
    return result
  }
  return schema.type === "boolean" ? false : schema.type === "number" || schema.type === "integer" ? (schema.minimum ?? 1) : ""
}

let mounted = true
onMounted(async () => {
  await loadSettings()
  if (!mounted) return
  setSettingsGuard({
    canLeave: () => {
      if (!draft.value) return true
      return JSON.stringify(draft.value) === baseline.value || confirm("Discard unsaved settings?")
    },
    isDirty: () => {
      if (!draft.value) return false
      return JSON.stringify(draft.value) !== baseline.value
    }
  })
})

onUnmounted(() => {
  mounted = false
  setSettingsGuard(null)
})

function openWorkspacePanel(panelId: string) {
  openPanel(panelId)
}
</script>

<template>
  <div id="settings-screen" class="settings-screen">
    <header class="settings-header">
      <button id="settings-menu" class="icon-button mobile-only" type="button" aria-label="Open navigation" aria-controls="side" @click="setDrawer(true)">
        <Menu class="w-5 h-5" />
      </button>
      <h1>Settings</h1>
      <button class="button variant-ghost" type="button" data-settings-close @click="navigate('chat')">
        <ArrowLeft class="w-4 h-4 mr-1" />
        <span>Back to chat</span>
      </button>
    </header>

    <div v-if="loading" class="settings-loading p-8 text-center text-muted-foreground">
      Loading settings...
    </div>

    <div v-else-if="loadError" class="settings-error p-8 text-center">
      <div class="text-destructive flex items-center justify-center gap-2 mb-4" role="alert">
        <AlertCircle class="w-5 h-5" />
        <span>{{ loadError }}</span>
      </div>
      <button class="button bg-primary text-primary-foreground px-4 py-2 rounded" type="button" @click="loadSettings">Retry</button>
    </div>

    <template v-if="true">
      <div class="settings-tabs" role="tablist" aria-label="Settings sections">
        <button
          v-for="(title, id) in tabNames"
          :key="id"
          type="button"
          role="tab"
          :id="'settings-tab-' + id"
          :data-settings-tab="id"
          aria-controls="settings-fields"
          :aria-selected="activeTab === id ? 'true' : 'false'"
          :tabindex="activeTab === id ? 0 : -1"
          @click="selectTab(String(id))"
          @keydown.right.prevent="selectTab(Object.keys(tabNames)[(Object.keys(tabNames).indexOf(String(id)) + 1) % Object.keys(tabNames).length])"
          @keydown.left.prevent="selectTab(Object.keys(tabNames)[(Object.keys(tabNames).indexOf(String(id)) - 1 + Object.keys(tabNames).length) % Object.keys(tabNames).length])"
        >
          {{ title }}
        </button>
      </div>

      <details v-if="saved" class="settings-file card p-4 mb-4">
        <summary class="cursor-pointer font-medium">Configuration file</summary>
        <p class="text-muted-foreground text-sm mt-2">{{ saved.path }}</p>
        <p class="text-muted-foreground text-sm mt-1">All tabs save to this file. Provider and MCP panels use the same file. Saved secret markers preserve existing values.</p>
        <p v-if="saved.environmentOverrides.length" class="text-muted-foreground text-sm mt-1">
          Environment overrides: {{ saved.environmentOverrides.join(", ") }}
        </p>
      </details>

      <div id="settings-fields" role="tabpanel" tabindex="0" class="settings-body grid gap-4">
        <!-- Workspace Tab -->
        <template v-if="activeTab === 'workspace'">
          <button type="button" class="workspace-link" data-panel="agents" @click="openWorkspacePanel('agents')">
            <Bot class="w-5 h-5 text-muted-foreground" />
            <div class="workspace-info">
              <span class="workspace-name">Subagents</span>
              <span class="workspace-desc">Delegated work in this conversation.</span>
            </div>
            <ChevronRight class="w-4 h-4 text-muted-foreground ml-auto" />
          </button>
          <button type="button" class="workspace-link" data-panel="analytics" @click="openWorkspacePanel('analytics')">
            <BarChart2 class="w-5 h-5 text-muted-foreground" />
            <div class="workspace-info">
              <span class="workspace-name">Analytics</span>
              <span class="workspace-desc">Model usage, token flow, and recorded cost.</span>
            </div>
            <ChevronRight class="w-4 h-4 text-muted-foreground ml-auto" />
          </button>
          <button type="button" class="workspace-link" data-panel="memory" @click="openWorkspacePanel('memory')">
            <Database class="w-5 h-5 text-muted-foreground" />
            <div class="workspace-info">
              <span class="workspace-name">Memory</span>
              <span class="workspace-desc">Search, save, and remove persistent facts.</span>
            </div>
            <ChevronRight class="w-4 h-4 text-muted-foreground ml-auto" />
          </button>
          <button type="button" class="workspace-link" data-panel="skills" @click="openWorkspacePanel('skills')">
            <Wrench class="w-5 h-5 text-muted-foreground" />
            <div class="workspace-info">
              <span class="workspace-name">Skills</span>
              <span class="workspace-desc">Browse the instructions available to Luna.</span>
            </div>
            <ChevronRight class="w-4 h-4 text-muted-foreground ml-auto" />
          </button>
          <button type="button" class="workspace-link" data-panel="lessons" @click="openWorkspacePanel('lessons')">
            <GraduationCap class="w-5 h-5 text-muted-foreground" />
            <div class="workspace-info">
              <span class="workspace-name">Lessons</span>
              <span class="workspace-desc">Review what Luna learned before it changes skills or memory.</span>
            </div>
            <ChevronRight class="w-4 h-4 text-muted-foreground ml-auto" />
          </button>
          <button type="button" class="workspace-link" data-panel="providers" @click="openWorkspacePanel('providers')">
            <Network class="w-5 h-5 text-muted-foreground" />
            <div class="workspace-info">
              <span class="workspace-name">Model providers</span>
              <span class="workspace-desc">Connect accounts and choose your default model.</span>
            </div>
            <ChevronRight class="w-4 h-4 text-muted-foreground ml-auto" />
          </button>
          <button type="button" class="workspace-link" data-panel="mcp" @click="openWorkspacePanel('mcp')">
            <Terminal class="w-5 h-5 text-muted-foreground" />
            <div class="workspace-info">
              <span class="workspace-name">MCP servers</span>
              <span class="workspace-desc">Connect external tools and manage their access.</span>
            </div>
            <ChevronRight class="w-4 h-4 text-muted-foreground ml-auto" />
          </button>
        </template>

        <!-- Models Tab -->
        <template v-else-if="activeTab === 'models' && saved && draft">
          <section class="card p-4 grid gap-2" data-section="models-refresh">
            <div class="flex items-center justify-between gap-4">
              <h2 class="text-lg font-semibold">Model catalog</h2>
              <button type="button" class="button border px-4 py-2 rounded font-medium" :disabled="isRefreshingModels" @click="refreshModels">
                {{ isRefreshingModels ? 'Refreshing…' : 'Refresh models' }}
              </button>
            </div>
            <p class="text-sm text-muted-foreground">Refreshes automatically at startup and every hour while Luna is running. Saved model definitions are kept.</p>
            <p v-if="models.refresh?.checkedAt" class="text-sm text-muted-foreground">Last checked: {{ new Date(models.refresh.checkedAt).toLocaleString() }}</p>
            <p v-if="modelRefreshMessage" role="status" class="text-sm">{{ modelRefreshMessage }}</p>
            <p v-else-if="models.refresh && Object.keys(models.refresh.errors).length" role="status" class="text-sm">Some providers could not refresh. Existing models are kept. {{ Object.entries(models.refresh.errors).map(([id, error]) => `${id}: ${error}`).join('; ') }}</p>
          </section>
          <section class="card p-4 grid gap-4" data-section="models-main">
            <h2 class="text-lg font-semibold">Main agent</h2>
            <div class="grid gap-2">
              <label class="field-label">
                <span>Main default model</span>
                <select
                  :value="getVal(['provider']) && getVal(['model']) ? getVal(['provider']) + '/' + getVal(['model']) : ''"
                  @change="(e: any) => {
                    const val = e.target.value
                    if (val === 'custom') return
                    const [prov, ...modParts] = val.split('/')
                    setVal(['provider'], prov || 'faux')
                    setVal(['model'], modParts.length ? modParts.join('/') : undefined)
                  }"
                  aria-label="Main default model"
                  class="input"
                >
                  <option value="">Runtime default</option>
                  <option v-for="modelObj in getModels()" :key="modelObj.provider + '/' + modelObj.id" :value="modelObj.provider + '/' + modelObj.id">
                    {{ modelObj.provider }} · {{ modelObj.name || modelObj.id }}
                  </option>
                  <template v-if="draft && draft.providers">
                    <template v-for="prov in (draft.providers as any[])" :key="prov.id">
                      <template v-for="m in ((prov.models || []) as any[])" :key="prov.id + '/' + m.id">
                        <option v-if="m.id" :value="prov.id + '/' + m.id">
                          {{ prov.name }} · {{ m.name || m.id }}
                        </option>
                      </template>
                    </template>
                  </template>
                  <option value="custom">Custom provider and model ID</option>
                </select>
              </label>
            </div>
            <div class="grid gap-2">
              <label class="field-label">
                <span>Main thinking level</span>
                <select
                  :value="getVal(['thinkingLevel']) ?? ''"
                  @change="(e: any) => setVal(['thinkingLevel'], e.target.value === '' ? undefined : e.target.value)"
                  data-setting="thinkingLevel"
                  aria-label="Main thinking level"
                  class="input"
                >
                  <option value="">Model default</option>
                  <option value="off">off</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </label>
            </div>
            <p class="text-muted-foreground text-sm">Defaults apply to new chat sessions. Each model can limit its supported thinking levels.</p>
          </section>

          <section class="card p-4 grid gap-4" data-section="models-subagents">
            <h2 class="text-lg font-semibold">Subagents</h2>
            <div class="grid gap-2">
              <label class="field-label">
                <span>Subagent default model</span>
                <select
                  :value="getVal(['subagents', 'provider']) && getVal(['subagents', 'model']) ? getVal(['subagents', 'provider']) + '/' + getVal(['subagents', 'model']) : ''"
                  @change="(e: any) => {
                    const val = e.target.value
                    if (val === '') {
                      setVal(['subagents', 'provider'], undefined)
                      setVal(['subagents', 'model'], undefined)
                      return
                    }
                    const [prov, ...modParts] = val.split('/')
                    setVal(['subagents', 'provider'], prov)
                    setVal(['subagents', 'model'], modParts.join('/'))
                  }"
                  aria-label="Subagent default model"
                  class="input"
                >
                  <option value="">Inherit parent model</option>
                  <option v-for="modelObj in getModels()" :key="'sub-' + modelObj.provider + '/' + modelObj.id" :value="modelObj.provider + '/' + modelObj.id">
                    {{ modelObj.provider }} · {{ modelObj.name || modelObj.id }}
                  </option>
                  <template v-if="draft && draft.providers">
                    <template v-for="prov in (draft.providers as any[])" :key="'sub-' + prov.id">
                      <template v-for="m in ((prov.models || []) as any[])" :key="'sub-' + prov.id + '/' + m.id">
                        <option v-if="m.id" :value="prov.id + '/' + m.id">
                          {{ prov.name }} · {{ m.name || m.id }}
                        </option>
                      </template>
                    </template>
                  </template>
                </select>
              </label>
            </div>
            <div class="grid gap-2">
              <label class="field-label">
                <span>Subagent thinking level</span>
                <select
                  :value="getVal(['subagents', 'thinkingLevel']) ?? ''"
                  @change="(e: any) => setVal(['subagents', 'thinkingLevel'], e.target.value === '' ? undefined : e.target.value)"
                  data-setting="subagents.thinkingLevel"
                  aria-label="Subagent thinking level"
                  class="input"
                >
                  <option value="">Inherit parent thinking level</option>
                  <option value="off">off</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </label>
            </div>
            <div class="grid gap-2">
              <label class="field-label">
                <span>Working directory</span>
                <input
                  type="text"
                  :value="getVal(['subagents', 'cwd']) ?? ''"
                  @input="(e: any) => setVal(['subagents', 'cwd'], e.target.value === '' ? undefined : e.target.value)"
                  data-setting="subagents.cwd"
                  aria-label="Working directory"
                  placeholder="Not set"
                  class="input"
                  autocomplete="off"
                />
              </label>
            </div>
            <p class="text-muted-foreground text-sm">Unset values inherit from the parent. Applies to normal and forked children.</p>
          </section>
          <section v-for="key in ['providers','auxiliary']" :key="key" class="card p-4 grid gap-4" :data-section="key">
            <h2 class="text-lg font-semibold">{{ titles[key] }}</h2>
            <ComponentField v-if="saved.schema.properties[key]" :schema="saved.schema.properties[key]" :path="[key]" :required="false" :get="getVal" :set="setVal" :seed="seedSchema" :label-for="labelFor" />
          </section>
        </template>

        <!-- Other Tabs -->
        <template v-else-if="saved && draft">
          <template v-for="key in groups[activeTab]" :key="key">
            <section class="card p-4 grid gap-4" :data-section="key">
              <h2 class="text-lg font-semibold">{{ titles[key] || key }}</h2>
              <ComponentField v-if="saved && saved.schema" :schema="saved.schema.properties[key]" :path="[key]" :required="(saved.schema.required || []).includes(key)" :get="getVal" :set="setVal" :seed="seedSchema" :label-for="labelFor" />

              <p v-if="key === 'busyInput'" class="text-muted-foreground text-sm">Applies now to all chats. Interrupt redirects the model; tools finish safely. Queue runs separate turns. Steer adds information at the next boundary. Use /queue, /steer, or /redirect for one message.</p>
              <p v-if="key === 'compaction'" class="text-muted-foreground text-sm">Applies live to existing sessions. Running tool calls finish first. Emergency overflow recovery stays enabled.</p>
              <p v-if="key === 'autoContinue'" class="text-muted-foreground text-sm">Applies live. When a turn stops on a rate or usage limit, Luna waits for the reset time and sends a continuation. Errors without a time retry after 2, 10, 30, then 60 minutes. Context, auth, and billing errors never wait. A new message cancels the wait.</p>
              <p v-if="key === 'processes'" class="text-muted-foreground text-sm">Allows native background shell commands with the same host access as bash. Completion resumes the owning chat. Normal shutdown stops commands. Save, then restart Luna to apply changes.</p>
              <p v-if="key === 'browser'" class="text-muted-foreground text-sm">Browser tools use the selected provider and its named MCP connection. Save, then restart Luna to apply routing changes.</p>
              <p v-if="key === 'web'" class="text-muted-foreground text-sm">Search and extraction use separate provider selections. DDGS uses the named MCP connection and its protected credentials. Save, then restart Luna to apply routing changes.</p>
            </section>
          </template>
        </template>

      </div>

      <div class="settings-footer mt-6 flex flex-col gap-4">
        <p class="text-muted-foreground text-sm">Provider definitions, MCP connections, and runtime changes made here need a restart. Provider and MCP panels can apply connection changes live.</p>
        <div v-if="saved && draft && activeTab !== 'workspace'" class="row flex gap-4">
          <button type="button" data-settings-save class="button bg-primary text-primary-foreground px-4 py-2 rounded font-medium" :disabled="isSaving" @click="saveSettings">
            {{ isSaving ? "Saving..." : "Save settings" }}
          </button>
          <button type="button" class="button border px-4 py-2 rounded font-medium" :disabled="isReloading" @click="reloadSettings">
            Reload
          </button>
        </div>
        <p class="muted text-sm text-muted-foreground" role="status" aria-live="polite">{{ statusText }}</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.settings-screen {
  padding: 24px;
  max-width: 900px;
  margin: 0 auto;
  overflow-y: auto;
  height: 100%;
}
.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
}
.settings-header h1 {
  font-size: 24px;
  font-weight: 700;
}
.settings-tabs {
  display: flex;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 24px;
  overflow-x: auto;
  padding-bottom: 4px;
}
.settings-tabs button {
  padding: 8px 16px;
  font-weight: 500;
  color: var(--muted-foreground);
  border-bottom: 2px solid transparent;
  background: none;
  cursor: pointer;
  white-space: nowrap;
}
.settings-tabs button[aria-selected="true"] {
  color: var(--foreground);
  border-bottom-color: var(--primary);
}
.workspace-link {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
  padding: 16px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--card-foreground);
  text-align: left;
  cursor: pointer;
  transition: background 0.2s;
}
.workspace-link:hover {
  background: var(--accent);
}
.workspace-info {
  display: flex;
  flex-direction: column;
  flex: 1;
}
.workspace-name {
  font-weight: 600;
}
.workspace-desc {
  font-size: 13px;
  color: var(--muted-foreground);
}
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.input {
  width: 100%;
  padding: 8px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--background);
  color: var(--foreground);
}
.field-label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 14px;
  font-weight: 500;
}
.mobile-only {
  display: none;
}
@media (max-width: 760px) {
  .mobile-only {
    display: inline-flex;
  }
}
</style>
