<script setup lang="ts">
import { confirmAction } from "@/lib/confirm";
import PanelStatus from "./PanelStatus.vue";
import { ref, onMounted } from "vue";
import { ChevronRight } from "@lucide/vue";
import { json, post } from "@/lib/api";
import { useToast } from "@/lib/toast";

const loading = ref(true);
const errorMsg = ref("");
const items = ref<any[]>([]);
const searchQuery = ref("");
const searchTimer = ref<any>(null);

// New memory form
const keyInput = ref("");
const contentInput = ref("");
const { toasts, toast } = useToast();

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
  if (await confirmAction({ title: "Forget this memory?", confirmLabel: "Forget", danger: true })) {
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
    <PanelStatus :toasts="toasts" :loading="loading" :error="errorMsg" />

    <!-- Remember Form Card -->
    <details class="card" data-manager-form="memory-add"><summary class="row"><ChevronRight :size="16" /><b>Save a memory</b></summary><div class="grid manager-body">
      <label class="field-label">
        <span>Key (optional, e.g. user.timezone)</span>
        <input placeholder="Key (optional, e.g. user.timezone)" v-model="keyInput" />
      </label>
      <label class="field-label">
        <span>Fact or note</span>
        <textarea dir="auto" rows="2" placeholder="Fact or note" v-model="contentInput"></textarea>
      </label>
      <div class="row">
        <button @click="saveMemory">Save</button>
      </div>
    </div></details>

    <!-- Search Input -->
    <label class="field-label">
      <span>Search memories</span>
      <input dir="auto" placeholder="Search memories" v-model="searchQuery" @input="handleSearchInput" />
    </label>

    <!-- Items List -->
    <div class="grid">
      <p v-if="!loading && !errorMsg && !items.length" class="muted">Nothing stored.</p>
      <details v-for="m in items" :key="m.id" class="card vl vl-md" :data-memory="m.id"><summary class="row"><ChevronRight :size="16" />
          <span class="pill">{{ m.kind }}</span>
          <b class="grow">{{ m.key || "#" + m.id }}</b>
          <span class="muted">{{ new Date(m.updated).toLocaleDateString() }}</span>
        </summary><div class="grid manager-body">
        <pre dir="auto">{{ m.content }}</pre><div><button @click="forgetMemory(m.id)">Forget</button></div>
      </div></details>
    </div>
  </div>
</template>

<style scoped>
@media (max-width: 760px) {
  button, summary.row { min-height: 44px; }
}
</style>
