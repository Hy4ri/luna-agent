<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { json, api, post } from "@/lib/api";
import { models, loadModels, modelKey } from "@/stores/models";

const loading = ref(true);
const errorMsg = ref("");
const providerData = ref<any>(null);
const toasts = ref<string[]>([]);
const activeLogin = ref<any>(null);
const loginPollingTimer = ref<any>(null);

// Custom provider form refs
const customId = ref("");
const customName = ref("");
const customApi = ref("openai-completions");
const customBaseUrl = ref("");
const customKey = ref("");
const customModels = ref("");
const addingCustom = ref(false);

// API key inputs for builtin providers
const apiKeys = ref<Record<string, string>>({});

// Default model selection
const selectedDefault = ref("");

function toast(text: string) {
  toasts.value.push(text);
  setTimeout(() => {
    const idx = toasts.value.indexOf(text);
    if (idx !== -1) toasts.value.splice(idx, 1);
  }, 2500);
}

async function fetchData() {
  loading.value = true;
  errorMsg.value = "";
  try {
    const r = await json("/v1/providers");
    providerData.value = r;
    if (r.default) {
      selectedDefault.value = r.default.provider + "/" + r.default.modelId;
    }
  } catch (e: any) {
    if (e.message !== "unauthorized") {
      errorMsg.value = e.message;
    }
  } finally {
    loading.value = false;
  }
}

async function saveDefaultModel() {
  if (!selectedDefault.value) return;
  const [provider, ...rest] = selectedDefault.value.split("/");
  const modelId = rest.join("/");
  try {
    await post("/v1/models/default", { provider, modelId }, "PUT");
    await loadModels();
    toast("default saved");
  } catch (e: any) {
    toast(e.message);
  }
}

async function saveApiKey(providerId: string) {
  const key = apiKeys.value[providerId] || "";
  try {
    await post(`/v1/providers/${providerId}/key`, { key }, "PUT");
    apiKeys.value[providerId] = "";
    await loadModels();
    await fetchData();
    toast("API key saved");
  } catch (e: any) {
    toast(e.message);
  }
}

async function disconnectProvider(providerId: string, name: string) {
  if (confirm(`Remove the stored ${name} credential?`)) {
    try {
      await json(`/v1/providers/${providerId}/credential`, { method: "DELETE" });
      await loadModels();
      await fetchData();
      toast("Disconnected");
    } catch (e: any) {
      toast(e.message);
    }
  }
}

async function removeCustomProvider(providerId: string) {
  if (confirm(`Remove provider ${providerId}?`)) {
    try {
      await json(`/v1/providers/custom/${providerId}`, { method: "DELETE" });
      await loadModels();
      await fetchData();
      toast("Provider removed");
    } catch (e: any) {
      toast(e.message);
    }
  }
}

async function addCustomProvider() {
  addingCustom.value = true;
  try {
    const modelsList = customModels.value.split(",").map(s => s.trim()).filter(Boolean);
    await post("/v1/providers/custom", {
      id: customId.value.trim(),
      name: customName.value.trim(),
      api: customApi.value,
      baseUrl: customBaseUrl.value.trim(),
      key: customKey.value,
      models: modelsList,
    });
    customId.value = "";
    customName.value = "";
    customBaseUrl.value = "";
    customKey.value = "";
    customModels.value = "";
    await loadModels();
    await fetchData();
    toast("Custom provider added");
  } catch (e: any) {
    toast(e.message);
  } finally {
    addingCustom.value = false;
  }
}

async function startLogin(providerId: string) {
  try {
    const l = await post(`/v1/providers/${providerId}/login`, { type: "oauth" });
    activeLogin.value = l;
    pollLogin(l.id);
  } catch (e: any) {
    toast(e.message);
  }
}

async function cancelLogin(loginId: string) {
  try {
    await json(`/v1/logins/${loginId}`, { method: "DELETE" });
    activeLogin.value = null;
    if (loginPollingTimer.value) clearTimeout(loginPollingTimer.value);
    await fetchData();
  } catch (e: any) {
    toast(e.message);
  }
}

async function answerLoginPrompt(loginId: string, seq: number, value: string) {
  try {
    await post(`/v1/logins/${loginId}/answer`, { seq, value });
  } catch (e: any) {
    toast(e.message);
  }
}

function pollLogin(loginId: string) {
  if (loginPollingTimer.value) clearTimeout(loginPollingTimer.value);
  loginPollingTimer.value = setTimeout(async () => {
    if (!activeLogin.value || activeLogin.value.id !== loginId) return;
    try {
      const l = await json(`/v1/logins/${loginId}`);
      activeLogin.value = l;
      if (l.status === "running") {
        pollLogin(loginId);
      } else {
        await loadModels();
        if (l.status === "done") {
          setTimeout(fetchData, 800);
        }
      }
    } catch {
      // ignore network errors during poll
      pollLogin(loginId);
    }
  }, 1000);
}

onMounted(() => {
  fetchData();
});

onUnmounted(() => {
  if (loginPollingTimer.value) clearTimeout(loginPollingTimer.value);
});
</script>

<template>
  <div class="grid">
    <!-- Toasts -->
    <div v-if="toasts.length" class="flex flex-col gap-1 mb-2">
      <div v-for="t in toasts" :key="t" class="muted text-xs">{{ t }}</div>
    </div>

    <!-- Loading / Error -->
    <p v-if="loading" class="muted" role="status">Loading…</p>
    <p v-if="errorMsg" class="msg err">{{ errorMsg }}</p>

    <template v-if="providerData">
      <!-- Default Model Card -->
      <div class="card grid">
        <b>Default model for new sessions and cron</b>
        <div class="row">
          <label class="field-label">
            <span>Model</span>
            <select v-model="selectedDefault" aria-label="Model">
              <option v-for="m in models.list" :key="modelKey(m)" :value="modelKey(m)">
                {{ m.provider }} · {{ m.name || m.id }}
              </option>
              <option v-if="selectedDefault && !models.list.some(m => modelKey(m) === selectedDefault)" :value="selectedDefault">
                {{ selectedDefault }}
              </option>
            </select>
          </label>
          <button @click="saveDefaultModel">Save</button>
        </div>
      </div>

      <!-- Interactive Login Box if active -->
      <div v-if="activeLogin" class="card grid">
        <div class="row">
          <b class="grow">Login: {{ activeLogin.providerId }}</b>
          <span class="pill" :class="{ ok: activeLogin.status === 'done', error: activeLogin.status === 'error' }">
            {{ activeLogin.status }}
          </span>
          <button v-if="activeLogin.status === 'running'" @click="cancelLogin(activeLogin.id)">Cancel</button>
        </div>
        <div v-for="(e, idx) in activeLogin.events" :key="idx">
          <div v-if="e.type === 'auth_url'">
            <a :href="e.url" target="_blank" rel="noopener noreferrer">Open sign-in page ↗</a>
            <div v-if="e.instructions" class="muted">{{ e.instructions }}</div>
          </div>
          <div v-else-if="e.type === 'device_code'">
            Code <b>{{ e.userCode }}</b> at <a :href="e.verificationUri" target="_blank" rel="noopener noreferrer">{{ e.verificationUri }}</a>
          </div>
          <div v-else class="muted">{{ e.message }}</div>
        </div>
        <pre v-if="activeLogin.error">{{ activeLogin.error }}</pre>
        <div v-if="activeLogin.prompt">
          <div class="muted">{{ activeLogin.prompt.message }}</div>
          <div v-if="activeLogin.prompt.type === 'select'" class="row">
            <button
              v-for="o in activeLogin.prompt.options"
              :key="o.id"
              :title="o.description || ''"
              @click="answerLoginPrompt(activeLogin.id, activeLogin.prompt.seq, o.id)"
            >
              {{ o.label }}
            </button>
          </div>
          <div v-else class="grid">
            <label class="field-label">
              <span>{{ activeLogin.prompt.placeholder || "Value" }}</span>
              <input
                :type="activeLogin.prompt.type === 'secret' ? 'password' : 'text'"
                :placeholder="activeLogin.prompt.placeholder || ''"
                @keydown.enter.prevent="(ev) => answerLoginPrompt(activeLogin.id, activeLogin.prompt.seq, (ev.target as HTMLInputElement).value)"
                ref="promptInputRef"
              />
            </label>
            <div class="row">
              <button @click="(ev) => {
                const input = (ev.target as HTMLElement).parentElement?.previousElementSibling?.querySelector('input');
                if (input) answerLoginPrompt(activeLogin.id, activeLogin.prompt.seq, input.value);
              }">Submit</button>
            </div>
            <div v-if="activeLogin.prompt.type === 'manual_code'" class="muted">
              On another device the browser cannot reach the callback. After you sign in, copy the final URL from the address bar (or the code shown) and paste it here.
            </div>
          </div>
        </div>
      </div>

      <!-- Builtin Providers -->
      <b>Providers</b>
      <div v-for="p in providerData.providers.filter((p: any) => !p.custom && p.id !== 'faux')" :key="p.id" class="card grid">
        <div class="row">
          <b class="grow">{{ p.name }}</b>
          <span class="pill" :class="{ ok: p.connected }">
            {{ p.connected ? ((p.via === 'oauth' ? 'subscription' : 'key') + (p.source ? ' · ' + p.source : '')) : (p.error ? 'error' : 'not connected') }}
          </span>
          <span class="muted">{{ p.models }} models</span>
        </div>
        <pre v-if="p.error">{{ p.error }}</pre>
        <div v-if="p.oauth" class="row">
          <button @click="startLogin(p.id)">
            {{ p.oauth.label || (p.oauth.subscription ? 'Sign in with subscription' : 'Sign in') }}
          </button>
          <span class="muted">{{ p.oauth.name }}</span>
        </div>
        <div v-if="p.apiKey" class="row">
          <label class="field-label flex-1">
            <span>API key</span>
            <input
              type="password"
              placeholder="API key"
              autocomplete="off"
              v-model="apiKeys[p.id]"
            />
          </label>
          <button @click="saveApiKey(p.id)">Save key</button>
        </div>
        <div v-if="p.connected && p.source && /stored|OAuth/i.test(p.source)" class="row">
          <button @click="disconnectProvider(p.id, p.name)">Disconnect</button>
        </div>
        <div v-if="p.id === 'anthropic' && p.oauth" class="muted">
          Note: Anthropic bills third-party apps on a Pro/Max login as extra usage, not plan limits. Check claude.ai/settings/usage.
        </div>
      </div>

      <!-- Custom API / Providers -->
      <b>Custom API</b>
      <div v-for="p in providerData.providers.filter((p: any) => p.custom)" :key="p.id" class="card grid">
        <div class="row">
          <b class="grow">{{ p.name }}</b>
          <span class="pill" :class="{ ok: p.connected }">{{ p.def.api }}</span>
          <span class="muted">{{ p.models }} models</span>
          <button style="color:var(--err)" @click="removeCustomProvider(p.id)">Remove</button>
        </div>
        <div class="muted">{{ p.def.baseUrl }} · {{ p.def.models.map((m: any) => m.id).join(', ') }}</div>
      </div>

      <!-- Add Custom Provider Form -->
      <div class="card grid">
        <b>Add custom provider</b>
        <label class="field-label">
          <span>id, e.g. local-llama</span>
          <input placeholder="id, e.g. local-llama" v-model="customId" />
        </label>
        <label class="field-label">
          <span>display name (optional)</span>
          <input placeholder="display name (optional)" v-model="customName" />
        </label>
        <label class="field-label">
          <span>API format</span>
          <select v-model="customApi" aria-label="API format">
            <option value="openai-completions">OpenAI-compatible (chat completions)</option>
            <option value="openai-responses">OpenAI Responses API</option>
            <option value="anthropic-messages">Anthropic-compatible (messages)</option>
          </select>
        </label>
        <label class="field-label">
          <span>base URL, e.g. http://192.168.1.10:8080/v1</span>
          <input placeholder="base URL, e.g. http://192.168.1.10:8080/v1" v-model="customBaseUrl" />
        </label>
        <label class="field-label">
          <span>API key (blank for none)</span>
          <input type="password" placeholder="API key (blank for none)" autocomplete="off" v-model="customKey" />
        </label>
        <label class="field-label">
          <span>model ids, comma separated (blank: auto-detect via /models)</span>
          <input placeholder="model ids, comma separated (blank: auto-detect via /models)" v-model="customModels" />
        </label>
        <div class="row">
          <button :disabled="addingCustom" @click="addCustomProvider">Add</button>
        </div>
      </div>
    </template>
  </div>
</template>
