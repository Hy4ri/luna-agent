<script setup lang="ts">
import PanelStatus from "./PanelStatus.vue";
import { confirmAction } from "@/lib/confirm";
import { ref, watch, onMounted } from "vue";
import ConnectionDefinitionEditor from "@/pages/settings/ConnectionDefinitionEditor.vue";
import { ChevronRight } from "@lucide/vue";
import { json, post } from "@/lib/api";
import { useToast } from "@/lib/toast";

import { useSettingsMutation } from "./useSettingsMutation";
const emit = defineEmits<{ busy: [value: boolean]; changed: [] }>();
const { pending, run } = useSettingsMutation(() => emit("changed"));
watch(pending, busy => emit("busy", busy), { flush: "sync" });
const loading = ref(true);
const errorMsg = ref("");
const mcpData = ref<any>(null);
const { toasts, toast } = useToast();
const connecting = ref(false);

// New server form state
const nameInput = ref("");
const transportInput = ref("http");
const targetInput = ref("");
const argsInput = ref("");
const secretsInput = ref("");
const deferInput = ref(true);

async function fetchData() {
  loading.value = true;
  errorMsg.value = "";
  try {
    const r = await json("/v1/mcp");
    mcpData.value = r;
  } catch (e: any) {
    if (e.message !== "unauthorized") {
      errorMsg.value = e.message;
    }
  } finally {
    loading.value = false;
  }
}

function parsePairs(text: string, sep: string) {
  return Object.fromEntries(
    text
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => {
        const i = l.indexOf(sep);
        return i < 0 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      })
  );
}

async function addServer() {
  const tr = transportInput.value;
  const name = nameInput.value.trim();
  const target = targetInput.value.trim();
  const body: any = { name, transport: tr, defer: deferInput.value };

  if (tr === "stdio") {
    body.command = target;
    if (argsInput.value.trim()) {
      body.args = argsInput.value.trim().split(/\s+/);
    }
    const envs = parsePairs(secretsInput.value, "=");
    if (Object.keys(envs).length) body.env = envs;
  } else {
    body.url = target;
    const hdrs = parsePairs(secretsInput.value, ":");
    if (Object.keys(hdrs).length) body.headers = hdrs;
  }

  connecting.value = true;
  toast("connecting...");
  try {
    await post("/v1/mcp", body);
    nameInput.value = "";
    targetInput.value = "";
    argsInput.value = "";
    secretsInput.value = "";
    await fetchData();
    toast("Connected and saved");
  } catch (e: any) {
    toast(e.message);
  } finally {
    connecting.value = false;
  }
}

async function toggleServerEnabled(serverName: string, currentEnabled: boolean) {
  try {
    await post(`/v1/mcp/${encodeURIComponent(serverName)}`, { enabled: !currentEnabled }, "PATCH");
    await fetchData();
  } catch (e: any) {
    toast(e.message);
  }
}

async function removeServer(serverName: string) {
  if (await confirmAction({ title: `Remove MCP server "${serverName}"?`, confirmLabel: "Remove", danger: true })) {
    try {
      await json(`/v1/mcp/${encodeURIComponent(serverName)}`, { method: "DELETE" });
      await fetchData();
      toast("Removed");
    } catch (e: any) {
      toast(e.message);
    }
  }
}

onMounted(() => {
  fetchData();
});
</script>

<template>
  <fieldset class="grid manager-form" :disabled="pending">
    <!-- Toasts -->
    <div v-if="toasts.length" class="flex flex-col gap-1 mb-2">
      <div v-for="t in toasts" :key="t" class="muted text-xs">{{ t }}</div>
    </div>

    <!-- Loading / Error -->
    <PanelStatus :loading="loading" :error="errorMsg" />

    <!-- Add MCP server form -->
    <details class="card" data-manager-form="mcp-add"><summary class="row"><ChevronRight :size="16" /><b>Add MCP server</b></summary><div class="grid manager-body">
      <label class="field-label">
        <span>name (letters, digits, _ -)</span>
        <input placeholder="name (letters, digits, _ -)" v-model="nameInput" />
      </label>
      <label class="field-label">
        <span>Transport</span>
        <select v-model="transportInput" aria-label="Transport">
          <option value="http">http (Streamable HTTP)</option>
          <option value="sse">sse</option>
          <option value="stdio">stdio (local command)</option>
        </select>
      </label>
      <label class="field-label">
        <span>{{ transportInput === 'stdio' ? 'command, e.g. npx' : 'https://host/mcp' }}</span>
        <input :placeholder="transportInput === 'stdio' ? 'command, e.g. npx' : 'https://host/mcp'" v-model="targetInput" />
      </label>
      <label class="field-label" v-if="transportInput === 'stdio'">
        <span>args, space separated</span>
        <input placeholder="args, space separated" v-model="argsInput" />
      </label>
      <label class="field-label">
        <span>{{ transportInput === 'stdio' ? 'env vars, one per line: KEY=value' : 'headers, one per line: Authorization: Bearer ...' }}</span>
        <textarea
          rows="2"
          :placeholder="transportInput === 'stdio' ? 'env vars, one per line: KEY=value' : 'headers, one per line: Authorization: Bearer ...'"
          v-model="secretsInput"
        ></textarea>
      </label>
      <label class="row muted cursor-pointer">
        <input type="checkbox" v-model="deferInput" />
        Defer tools (load on demand with tool_search; keeps the prompt small)
      </label>
      <div class="row">
        <button :disabled="connecting" @click="run(addServer)">Connect and save</button>
      </div>
    </div></details>

    <template v-if="mcpData">
      <p v-if="!mcpData.servers.length" class="muted">No MCP servers yet.</p>
      <details v-for="s in mcpData.servers" :key="s.name" class="card"><summary class="row"><ChevronRight :size="16" />
          <b class="grow">{{ s.name }}</b>
          <span :style="{ color: s.status === 'connected' ? 'var(--ok)' : s.status === 'failed' ? 'var(--err)' : 'var(--dim)' }">
            {{ s.status }}
          </span>
          <span class="muted">{{ s.transport }} · {{ s.source }}</span>
        </summary><div class="grid manager-body">
        <span class="muted">{{ s.target }}</span>
        <span v-if="s.secretKeys.length" class="muted">secrets: {{ s.secretKeys.join(', ') }} (hidden)</span>
        <span v-if="s.error" :style="{ color: 'var(--err)' }">{{ s.error }}</span>
        <details v-if="s.tools.length">
          <summary class="muted">{{ s.tools.length }} tools{{ s.defer ? ' (deferred)' : '' }}</summary>
          <pre class="code">{{ s.tools.join('\n') }}</pre>
        </details>
        <div v-if="s.source === 'web'" class="row">
          <button @click="run(() => toggleServerEnabled(s.name, s.enabled))">{{ s.enabled ? 'Disable' : 'Enable' }}</button>
          <button @click="run(() => removeServer(s.name))">Remove</button>
        </div>
        <span v-else class="muted">From the settings file.</span>
        <ConnectionDefinitionEditor collection="mcpServers" :name="s.name" @busy="emit('busy', $event)" @changed="run(fetchData)" />
      </div></details>
    </template>

    <p class="muted">New sessions see changes at once; running sessions pick them up on their next turn.</p>
  </fieldset>
</template>

<style scoped>
.manager-form { border: 0; padding: 0; margin: 0; min-width: 0; }
</style>
