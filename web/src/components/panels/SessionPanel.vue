<script setup lang="ts">
import { ref, onMounted } from "vue";
import { json, api, post } from "@/lib/api";
import { chat, openSession } from "@/stores/chat";
import { closePanel } from "@/stores/app";

const loading = ref(true);
const errorMsg = ref("");
const sessionData = ref<any>(null);
const toasts = ref<string[]>([]);
const instructions = ref("");

function toast(text: string) {
  toasts.value.push(text);
  setTimeout(() => {
    const idx = toasts.value.indexOf(text);
    if (idx !== -1) toasts.value.splice(idx, 1);
  }, 2500);
}

async function fetchData() {
  if (!chat.session) {
    loading.value = false;
    return;
  }
  loading.value = true;
  errorMsg.value = "";
  try {
    const r = await json(`/v1/sessions/${chat.session}?limit=1`);
    sessionData.value = r;
    instructions.value = r.agent?.instructions || "";
  } catch (e: any) {
    if (e.message !== "unauthorized") {
      errorMsg.value = e.message;
    }
  } finally {
    loading.value = false;
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
  if (confirm("Start a fresh context? History stays stored.")) {
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
  fetchData();
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

    <template v-if="!chat.session">
      <p class="muted">Open a session first.</p>
    </template>

    <template v-else-if="sessionData">
      <div class="card grid">
        <b>Instructions</b>
        <textarea rows="5" placeholder="Extra instructions for this session (system prompt addition)" v-model="instructions"></textarea>
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
