<script setup lang="ts">
import { ref, onMounted } from "vue";
import { json } from "@/lib/api";
import { chat, openSession, sortChildren } from "@/stores/chat";
import { closePanel } from "@/stores/app";
import { useToast } from "@/lib/toast";

const loading = ref(true);
const errorMsg = ref("");
const sessionData = ref<any>(null);
const childSessions = ref<any[]>([]);
const { toasts, toast } = useToast();

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
    if (r.children && r.children.length) {
      const details = [];
      for (const c of r.children) {
        const st = await json(`/v1/sessions/${c.id}?limit=1`).catch(() => null);
        details.push({ ...c, st });
      }
      childSessions.value = details;
    } else {
      childSessions.value = [];
    }
  } catch (e: any) {
    if (e.message !== "unauthorized") {
      errorMsg.value = e.message;
    }
  } finally {
    loading.value = false;
  }
}

async function openChildSession(childId: string | number) {
  closePanel();
  await openSession(childId);
}

async function stopChildSession(childId: string | number) {
  try {
    await json(`/v1/sessions/${childId}/abort`, { method: "POST" });
    toast("stopped " + childId);
    await fetchData();
  } catch (e: any) {
    toast(e.message);
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
      <p v-if="!sessionData.children || !sessionData.children.length" class="muted">
        This session has not spawned subagents. Ask Luna to delegate with delegate_task.
      </p>

      <div v-for="c in sortChildren(childSessions)" :key="c.id" class="card">
        <div class="row">
          <span class="grow">#{{ c.id }} {{ c.task }}</span>
          <button @click="openChildSession(c.id)">Open</button>
          <button @click="stopChildSession(c.id)">Stop</button>
        </div>
        <span v-if="c.st?.usage?.models" class="muted">
          {{ Object.keys(c.st.usage.models).join(", ") }}
        </span>
      </div>
    </template>
  </div>
</template>
