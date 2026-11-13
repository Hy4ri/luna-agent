<script setup lang="ts">
import { confirmAction } from "@/lib/confirm";
import { ref, onMounted } from "vue";
import { Copy, Trash2 } from "@lucide/vue";
import { json, post } from "@/lib/api";
import { loadWorkers, workers, type WorkerRow } from "@/stores/workers";

const errorMsg = ref("");
const name = ref("");
const adding = ref(false);
const created = ref<{ name: string; token: string } | null>(null);

const mainUrl = location.origin;
const command = (token: string) => `LUNA_URL=${mainUrl} LUNA_WORKER_TOKEN=${token} bun run worker`;

async function refresh() {
  errorMsg.value = "";
  try { await loadWorkers(); } catch (e: any) { if (e.message !== "unauthorized") errorMsg.value = e.message; }
}
async function add() {
  adding.value = true; errorMsg.value = "";
  try {
    const r = await post<{ worker: WorkerRow; token: string }>("/v1/workers", { name: name.value });
    created.value = { name: r.worker.name, token: r.token }; name.value = "";
    await refresh();
  } catch (e: any) { errorMsg.value = e.message; }
  finally { adding.value = false; }
}
async function remove(w: WorkerRow) {
  if (!(await confirmAction({ title: `Remove "${w.name}"?`, message: 'Its token stops working and its sessions cannot run tools until moved.', confirmLabel: 'Remove', danger: true }))) return;
  try { await json(`/v1/workers/${w.id}`, { method: "DELETE" }); await refresh(); }
  catch (e: any) { errorMsg.value = e.message; }
}
async function copy(text: string) { try { await navigator.clipboard.writeText(text); } catch {} }
const seen = (w: WorkerRow) => w.online ? "Online" : w.lastSeenAt ? `Offline · last seen ${new Date(w.lastSeenAt).toLocaleString()}` : "Never connected";
onMounted(refresh);

</script>

<template>
  <div class="grid" id="workers-panel">
    <p v-if="errorMsg" class="msg err" role="alert">{{ errorMsg }}</p>

    <div v-if="created" class="card grid" id="worker-token">
      <b>Token for "{{ created.name }}"</b>
      <p class="muted text-xs">Shown once. Run this in a luna-agent checkout on that machine. The worker dials this address, so it must reach it.</p>
      <pre class="select-all whitespace-pre-wrap break-all">{{ command(created.token) }}</pre>
      <div class="row">
        <button type="button" @click="copy(command(created.token))"><Copy :size="14" /> Copy command</button>
        <button type="button" @click="created = null">Done</button>
      </div>
    </div>

    <ul class="grid gap-2" aria-label="Execution machines">
      <li class="card row" data-worker="main">
        <div class="flex-1 min-w-0"><b>This host</b><div class="muted text-xs">Main Luna daemon. Always available.</div></div>
      </li>
      <li v-for="w in workers.list" :key="w.id" class="card row" :data-worker="w.id">
        <div class="flex-1 min-w-0">
          <b>{{ w.name }}</b>
          <div class="muted text-xs" :data-online="w.online">
            <span class="worker-dot" :class="{ on: w.online }" aria-hidden="true"></span>{{ seen(w) }}
          </div>
          <div v-if="w.capabilities" class="muted text-xs truncate">{{ w.capabilities.user }}@{{ w.capabilities.hostname }} · {{ w.capabilities.platform }}/{{ w.capabilities.arch }} · {{ w.capabilities.cwd }}</div>
        </div>
        <button type="button" class="icon-button" :aria-label="'Remove ' + w.name" title="Remove" @click="remove(w)"><Trash2 :size="16" /></button>
      </li>
    </ul>

    <form class="card grid" @submit.prevent="add">
      <b>Add a machine</b>
      <p class="muted text-xs">File, shell, and background-process tools of sessions on that machine run there. Other tools stay on this host.</p>
      <div class="row">
        <input v-model="name" placeholder="Name, e.g. desktop" aria-label="Machine name" maxlength="40" required class="flex-1" />
        <button type="submit" :disabled="adding || !name.trim()">Create token</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.worker-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; background: var(--muted-foreground); vertical-align: middle; }
.worker-dot.on { background: var(--success); }
</style>
