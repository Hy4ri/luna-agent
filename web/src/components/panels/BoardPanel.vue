<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue";
import { json, api, post } from "@/lib/api";
import { history, loadProjects } from "@/stores/sessions";
import { boardChanged } from "@/stores/app";

const COLUMNS = [
  ["backlog", "Backlog"],
  ["todo", "To do"],
  ["in_progress", "In progress"],
  ["review", "Review"],
  ["done", "Done"],
] as const;

const PRI = [
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["urgent", "Urgent"],
] as const;

const loading = ref(true);
const errorMsg = ref("");
const cards = ref<any[]>([]);
const boardArchived = ref(false);
const editingCard = ref<any | null>(null); // null = board view, {} = new card, card = edit card
const isNewCard = ref(false);

// Edit/New form fields
const fSubject = ref("");
const fDescription = ref("");
const fPriority = ref<any>("medium");
const fStatus = ref<any>("backlog");
const fOwner = ref("");
const fLabels = ref("");
const fBlocked = ref("");

const toasts = ref<string[]>([]);

function toast(text: string) {
  toasts.value.push(text);
  setTimeout(() => {
    const idx = toasts.value.indexOf(text);
    if (idx !== -1) toasts.value.splice(idx, 1);
  }, 2500);
}

// Project selection persistence exactly like vanilla
const selectedPid = ref<string>("");

function getActiveProjectId(): number {
  if (!history.projects.length) return 0;
  let savedPid = localStorage.getItem("luna.project");
  if (!savedPid || !history.projects.some(p => String(p.id) === savedPid)) {
    savedPid = String(history.projects[0].id);
    localStorage.setItem("luna.project", savedPid);
  }
  return Number(savedPid);
}

async function loadBoard() {
  loading.value = true;
  errorMsg.value = "";
  try {
    await loadProjects();
    if (!history.projects.length) {
      loading.value = false;
      return;
    }
    const pid = getActiveProjectId();
    selectedPid.value = String(pid);
    const base = `/v1/projects/${pid}`;
    const r = await json(`${base}/board${boardArchived.value ? "?archived=1" : ""}`);
    cards.value = r.cards || [];
  } catch (e: any) {
    if (e.message !== "unauthorized") {
      errorMsg.value = e.message;
    }
  } finally {
    loading.value = false;
  }
}

function handleProjectChange(e: Event) {
  const val = (e.target as HTMLSelectElement).value;
  localStorage.setItem("luna.project", val);
  selectedPid.value = val;
  loadBoard();
}

function openEdit(c: any | null) {
  editingCard.value = c;
  isNewCard.value = !c;
  fSubject.value = c?.subject || "";
  fDescription.value = c?.description || "";
  fPriority.value = c?.priority || "medium";
  fStatus.value = c?.status || "backlog";
  fOwner.value = c?.owner || "";
  fLabels.value = (c?.labels || []).join(", ");
  fBlocked.value = (c?.blockedBy || []).join(", ");
}

function closeEdit() {
  editingCard.value = null;
  isNewCard.value = false;
  loadBoard();
}

async function saveCard() {
  const pid = getActiveProjectId();
  const base = `/v1/projects/${pid}`;
  const list = (v: string) => v.split(",").map(x => x.trim()).filter(Boolean);
  const data = {
    subject: fSubject.value,
    description: fDescription.value,
    priority: fPriority.value,
    status: fStatus.value,
    owner: fOwner.value.trim() || null,
    labels: list(fLabels.value),
    blockedBy: list(fBlocked.value).map(x => Number(x.replace("#", ""))),
  };

  try {
    if (editingCard.value && !isNewCard.value && editingCard.value.id) {
      await post(`${base}/cards/${editingCard.value.id}`, data, "PATCH");
    } else {
      await post(`${base}/cards`, data);
    }
    closeEdit();
    toast("Saved");
  } catch (e: any) {
    toast(e.message);
  }
}

async function archiveCard(c: any) {
  const pid = getActiveProjectId();
  const base = `/v1/projects/${pid}`;
  try {
    await post(`${base}/cards/${c.id}`, { archived: !c.archived }, "PATCH");
    closeEdit();
    toast(c.archived ? "Restored" : "Archived");
  } catch (e: any) {
    toast(e.message);
  }
}

async function deleteCard(c: any) {
  if (confirm(`Delete card #${c.id} permanently?`)) {
    const pid = getActiveProjectId();
    const base = `/v1/projects/${pid}`;
    try {
      const r = await api(`${base}/cards/${c.id}`, { method: "DELETE" });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || r.statusText);
      }
      closeEdit();
      toast("Deleted");
    } catch (e: any) {
      toast(e.message);
    }
  }
}

async function moveCardStatus(c: any, newStatus: string) {
  const pid = getActiveProjectId();
  const base = `/v1/projects/${pid}`;
  try {
    await post(`${base}/cards/${c.id}`, { status: newStatus }, "PATCH");
    await loadBoard();
  } catch (e: any) {
    toast(e.message);
  }
}

// Watch boardChanged event from sync feed (unless currently editing)
watch(boardChanged, () => {
  if (editingCard.value === null) {
    loadBoard();
  }
});

onMounted(() => {
  loadBoard();
});
</script>

<template>
  <div class="grid">
    <!-- Toasts -->
    <div v-if="toasts.length" class="flex flex-col gap-1 mb-2">
      <div v-for="t in toasts" :key="t" class="muted text-xs">{{ t }}</div>
    </div>

    <!-- No projects case -->
    <p v-if="!history.projects.length" class="muted">Create a project first to use its board.</p>

    <template v-else>
      <!-- Top controls row -->
      <div class="row">
        <select aria-label="Project" :value="selectedPid" @change="handleProjectChange">
          <option v-for="p in history.projects" :key="p.id" :value="String(p.id)">
            {{ p.name }}
          </option>
        </select>
        <button @click="boardArchived = !boardArchived; loadBoard()">
          {{ boardArchived ? 'Back to board' : 'Archived' }}
        </button>
        <button v-if="!boardArchived && editingCard === null" @click="openEdit({})">
          New card
        </button>
      </div>

      <!-- Loading / Error -->
      <p v-if="loading" class="muted" role="status">Loading…</p>
      <p v-if="errorMsg" class="msg err">{{ errorMsg }}</p>

      <!-- Edit / New Card Form view -->
      <div v-if="editingCard !== null" class="card grid">
        <b>{{ isNewCard ? 'New card' : 'Card #' + editingCard.id }}</b>

        <label class="field-label">
          <span>Name</span>
          <input aria-label="Name" v-model="fSubject" />
        </label>

        <label class="field-label">
          <span>Description</span>
          <textarea rows="5" aria-label="Description" v-model="fDescription"></textarea>
        </label>

        <div class="row">
          <label class="field-label">
            <span>Priority</span>
            <select aria-label="Priority" v-model="fPriority">
              <option v-for="[v, t] in PRI" :key="v" :value="v">{{ t }}</option>
            </select>
          </label>
          <label class="field-label">
            <span>Column</span>
            <select aria-label="Column" v-model="fStatus">
              <option v-for="[v, t] in COLUMNS" :key="v" :value="v">{{ t }}</option>
            </select>
          </label>
        </div>

        <label class="field-label">
          <span>Owner</span>
          <input aria-label="Owner" v-model="fOwner" />
        </label>

        <label class="field-label">
          <span>Labels, comma separated</span>
          <input aria-label="Labels, comma separated" v-model="fLabels" />
        </label>

        <label class="field-label">
          <span>Waits on card ids, comma separated</span>
          <input aria-label="Waits on card ids, comma separated" v-model="fBlocked" />
        </label>

        <div class="row">
          <button @click="saveCard">Save</button>
          <button @click="closeEdit">Cancel</button>
          <button v-if="!isNewCard" @click="archiveCard(editingCard)">
            {{ editingCard.archived ? 'Restore' : 'Archive' }}
          </button>
          <button v-if="!isNewCard" style="color:var(--err)" @click="deleteCard(editingCard)">Delete</button>
        </div>
      </div>

      <!-- Archived Cards View -->
      <template v-else-if="boardArchived">
        <p v-if="!cards.length" class="muted">No archived cards.</p>
        <div v-for="c in cards" :key="c.id" class="kcard">
          <button class="subject" @click="openEdit(c)">#{{ c.id }} {{ c.subject }}</button>
        </div>
      </template>

      <!-- Active Kanban Board View -->
      <div v-else class="kanban">
        <template v-if="!loading">
          <div v-for="[status, title] in COLUMNS" :key="status" class="col">
            <div class="eyebrow">
              <span>{{ title }}</span>
              <span>{{ cards.filter(c => c.status === status).length }}</span>
            </div>

            <div
              v-for="c in cards.filter(c => c.status === status)"
              :key="c.id"
              class="kcard"
              :class="c.priority"
            >
              <button class="subject" @click="openEdit(c)">#{{ c.id }} {{ c.subject }}</button>

              <div class="row">
                <span class="pill">{{ c.priority }}</span>
                <span v-if="c.owner" class="muted">{{ c.owner }}</span>
                <span v-for="l in c.labels" :key="l" class="pill">{{ l }}</span>
                <span v-if="c.blockedBy.filter((d: number) => !cards.some(other => other.id === d && other.status === 'done')).length" class="muted">
                  waits on {{ c.blockedBy.filter((d: number) => !cards.some(other => other.id === d && other.status === 'done')).map((d: number) => '#' + d).join(', ') }}
                </span>
              </div>

              <select aria-label="Move card #{{ c.id }}" :value="c.status" @change="(e) => moveCardStatus(c, (e.target as HTMLSelectElement).value)">
                <option v-for="[st, stTitle] in COLUMNS" :key="st" :value="st">{{ stTitle }}</option>
              </select>
            </div>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>
