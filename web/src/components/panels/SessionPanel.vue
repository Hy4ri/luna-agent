<script setup lang="ts">
import PanelStatus from "./PanelStatus.vue";
import { confirmAction } from "@/lib/confirm";
import { ref, onMounted, onUnmounted, watch } from "vue";
import { json, post, serverUrl, token } from "@/lib/api";
import { chat, openSession } from "@/stores/chat";
import { closePanel } from "@/stores/app";
import { useToast } from "@/lib/toast";

import { loadWorkers, workers } from "@/stores/workers";
const target = ref("");
const targetCwd = ref("");
const moving = ref(false);
async function moveMachine() {
  if (moving.value) return;
  const worker = target.value ? Number(target.value) : null;
  if (!chat.session) {
    chat.draftWorker = worker; chat.draftCwd = targetCwd.value.trim();
    toast("Execution machine selected for the new session."); return;
  }
  moving.value = true;
  const sid = chat.session;
  try {
    const r = await post(`/v1/sessions/${sid}/machine`, { worker, cwd: targetCwd.value.trim() || null }, "PUT");
    if (chat.session === sid) { chat.machine = r.machine; chat.cwd = r.cwd; await fetchData(); }
    toast("Future file and command tools use the selected machine. Existing files and processes stay where they are.");
  } catch (e: any) { toast(e.message); }
  finally { moving.value = false; }
}
const loading = ref(true);
const errorMsg = ref("");
const sessionData = ref<any>(null);
const { toasts, toast } = useToast();
const instructions = ref("");

let requestGeneration = 0, disposed = false;
let readController: AbortController | undefined;
async function fetchData() {
  if (disposed) return;
  const generation = ++requestGeneration, sid = chat.session;
  readController?.abort();
  const controller = new AbortController();
  readController = controller;
  sessionData.value = null;
  instructions.value = "";
  target.value = sid ? "" : (chat.draftWorker ? String(chat.draftWorker) : "");
  targetCwd.value = sid ? "" : chat.draftCwd;
  errorMsg.value = "";
  const current = () => !disposed && generation === requestGeneration && sid === chat.session;
  if (!sid) {
    loading.value = false;
    return;
  }
  loading.value = true;
  errorMsg.value = "";
  try {
    const r = await json(`/v1/sessions/${sid}?limit=1`, { signal: controller.signal });
    if (!current()) return;
    sessionData.value = r;
    target.value = r.machine ? String(r.machine.id) : "";
    targetCwd.value = r.agent?.cwd || "";
    instructions.value = r.agent?.instructions || "";
  } catch (e: any) {
    if (current() && !controller.signal.aborted && e.message !== "unauthorized") {
      errorMsg.value = e.message;
    }
  } finally {
    if (current()) { loading.value = false; readController = undefined; }
  }
}

async function saveInstructions() {
  if (!chat.session) return;
  try {
    await post(`/v1/sessions/${chat.session}`, { instructions: instructions.value }, "PATCH");
    toast("saved");
  } catch (e: any) {
    toast(e.message);
  }
}

async function compactSession() {
  if (!chat.session) return;
  try {
    await post(`/v1/sessions/${chat.session}/compact`);
    toast("compaction started");
  } catch (e: any) {
    toast(e.message);
  }
}

async function resetSessionContext() {
  if (!chat.session) return;
  if (await confirmAction({ title: "Start a fresh context?", message: "History stays stored.", confirmLabel: "Start fresh" })) {
    try {
      await post(`/v1/sessions/${chat.session}/reset`);
      const sId = chat.session;
      closePanel();
      openSession(sId);
    } catch (e: any) {
      toast(e.message);
    }
  }
}

onMounted(() => {
  target.value = chat.draftWorker ? String(chat.draftWorker) : "";
  targetCwd.value = chat.draftCwd;
  loadWorkers().catch(e => { errorMsg.value = e.message; });
  fetchData();
});
watch([() => chat.session, serverUrl, token], fetchData, { flush: "sync" });
onUnmounted(() => { disposed = true; requestGeneration++; readController?.abort(); });
</script>

<template>
  <div class="grid">

    <!-- Loading / Error -->
    <PanelStatus :toasts="toasts" :loading="loading" :error="errorMsg" />

    <div class="card grid" id="machine-picker">
      <b>Execution machine</b>
      <label>Machine
        <select v-model="target" aria-label="Target machine" :disabled="loading || !!errorMsg || moving || chat.runActive">
          <option value="">This host</option>
          <option v-for="w in workers.list" :key="w.id" :value="String(w.id)">{{ w.name }} · {{ w.online ? 'Online' : 'Offline' }}</option>
        </select>
      </label>
      <label>Working directory
        <input v-model="targetCwd" aria-label="Target working directory" placeholder="Machine default directory" :disabled="loading || !!errorMsg || moving || chat.runActive" />
      </label>
      <p class="muted text-xs">File and command tools use this machine. Browser and other tools stay on the main host. Files and running processes do not move.</p>
      <button type="button" :disabled="loading || !!errorMsg || moving || chat.runActive" @click="moveMachine">{{ chat.session ? 'Move future execution' : 'Select execution machine' }}</button>
      <span v-if="chat.runActive" class="muted text-xs">Stop or wait for the current turn before moving execution.</span>
    </div>

    <template v-if="!chat.session">
      <p class="muted">Open a session first.</p>
    </template>

    <template v-else-if="sessionData">
      <div class="card grid">
        <b>Instructions</b>
        <textarea dir="auto" rows="5" placeholder="Extra instructions for this session (system prompt addition)" v-model="instructions"></textarea>
        <div class="row">
          <button @click="saveInstructions">Save</button>
        </div>
      </div>

      <div class="card grid">
        <b>Context</b>
        <div class="row">
          <button @click="compactSession">Compact</button>
          <button @click="resetSessionContext">Reset context</button>
        </div>
        <span class="muted">cwd: {{ sessionData.agent?.cwd || "(default)" }}</span>
      </div>

      <div class="card">
        <b>Tools ({{ sessionData.agent?.tools?.length || 0 }})</b>
        <pre>{{ sessionData.agent?.tools?.join(", ") }}</pre>
      </div>
    </template>
  </div>
</template>
