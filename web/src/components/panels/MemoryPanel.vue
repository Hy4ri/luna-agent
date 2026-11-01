<script setup lang="ts">
import { ref, onMounted } from "vue";
import { ChevronRight } from "@lucide/vue";
import { json, post } from "@/lib/api";

const loading = ref(true);
const errorMsg = ref("");
const items = ref<any[]>([]);
const searchQuery = ref("");
const searchTimer = ref<any>(null);

// New memory form
const keyInput = ref("");
const contentInput = ref("");
const toasts = ref<string[]>([]);

function toast(text: string) {
  toasts.value.push(text);
  setTimeout(() => {
    const idx = toasts.value.indexOf(text);
    if (idx !== -1) toasts.value.splice(idx, 1);
  }, 2500);
}

async function loadMemory() {
  loading.value = true;
  errorMsg.value = "";
  try {
    const r = await json("/v1/memory?q=" + encodeURIComponent(searchQuery.value));
    if (r.error) {
      errorMsg.value = r.error;
      items.value = [];
    } else {
      items.value = r.items || [];
    }
  } catch (e: any) {
    if (e.message !== "unauthorized") {
      errorMsg.value = e.message;
    }
  } finally {
    loading.value = false;
  }
}

function handleSearchInput() {
  if (searchTimer.value) clearTimeout(searchTimer.value);
  searchTimer.value = setTimeout(() => {
    loadMemory();
  }, 250);
}

async function saveMemory() {
  try {
    await post("/v1/memory", {
      content: contentInput.value,
      key: keyInput.value.trim() || undefined,
    });
    contentInput.value = "";
    keyInput.value = "";
    loadMemory();
    toast("Saved");
  } catch (e: any) {
    toast(e.message);
  }
}

async function forgetMemory(id: number | string) {
  if (confirm("Forget this?")) {
    try {
      await json(`/v1/memory/${id}`, { method: "DELETE" });
      loadMemory();
      toast("Forgotten");
    } catch (e: any) {
      toast(e.message);
    }
  }
}

onMounted(() => {
  loadMemory();
});
</script>

<template>
  <div class="grid">
    <!-- Toasts -->
    <div v-if="toasts.length" class="flex flex-col gap-1 mb-2">
      <div v-for="t in toasts" :key="t" class="muted text-xs">{{ t }}</div>
    </div>

    <!-- Error -->
    <p v-if="errorMsg" class="msg err">{{ errorMsg }}</p>

    <!-- Remember Form Card -->
    <details class="card" data-manager-form="memory-add"><summary class="row"><ChevronRight :size="16" /><b>Save a memory</b></summary><div class="grid manager-body">
      <label class="field-label">
        <span>key (optional, e.g. user.timezone)</span>
        <input placeholder="key (optional, e.g. user.timezone)" v-model="keyInput" />
      </label>
      <label class="field-label">
        <span>fact or note</span>
        <textarea dir="auto" rows="2" placeholder="fact or note" v-model="contentInput"></textarea>
      </label>
      <div class="row">
        <button @click="saveMemory">Save</button>
      </div>
    </div></details>

    <!-- Search Input -->
    <label class="field-label">
      <span>search</span>
      <input dir="auto" placeholder="search" v-model="searchQuery" @input="handleSearchInput" />
    </label>

    <!-- Loading -->
    <p v-if="loading" class="muted" role="status">Loading…</p>

    <!-- Items List -->
    <div class="grid">
      <p v-if="!loading && !items.length" class="muted">Nothing stored.</p>
      <details v-for="m in items" :key="m.id" class="card" :data-memory="m.id"><summary class="row"><ChevronRight :size="16" />
          <span class="pill">{{ m.kind }}</span>
          <b class="grow">{{ m.key || "#" + m.id }}</b>
          <span class="muted">{{ new Date(m.updated).toLocaleDateString() }}</span>
        </summary><div class="grid manager-body">
        <pre dir="auto">{{ m.content }}</pre><div><button @click="forgetMemory(m.id)">Forget</button></div>
      </div></details>
    </div>
  </div>
</template>
