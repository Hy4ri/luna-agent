<script setup lang="ts">
import { ref, onMounted } from "vue";
import { json, api, post } from "@/lib/api";
import { loadProjects, loadSessions, history } from "@/stores/sessions";
import { closePanel } from "@/stores/app";

const loading = ref(true);
const errorMsg = ref("");
const projects = ref<any[]>([]);
const toasts = ref<string[]>([]);

// New project form
const newName = ref("");
const newCwd = ref("");

// Editable project states
const editNames = ref<Record<number, string>>({});
const editCwds = ref<Record<number, string>>({});

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
    const r = await json("/v1/projects");
    if (r.error) {
      errorMsg.value = r.error;
      projects.value = [];
    } else {
      projects.value = r.projects || [];
      for (const p of projects.value) {
        if (editNames.value[p.id] === undefined) editNames.value[p.id] = p.name;
        if (editCwds.value[p.id] === undefined) editCwds.value[p.id] = p.cwd;
      }
    }
  } catch (e: any) {
    if (e.message !== "unauthorized") {
      errorMsg.value = e.message;
    }
  } finally {
    loading.value = false;
  }
}

async function addProject() {
  try {
    await post("/v1/projects", { name: newName.value, cwd: newCwd.value.trim() });
    newName.value = "";
    newCwd.value = "";
    await loadProjects();
    await loadSessions();
    await fetchData();
    toast("Project added");
  } catch (e: any) {
    toast(e.message);
  }
}

async function saveProject(p: any) {
  try {
    await post(`/v1/projects/${p.id}`, { name: editNames.value[p.id], cwd: (editCwds.value[p.id] || "").trim() }, "PATCH");
    await loadProjects();
    await loadSessions();
    await fetchData();
    toast("Saved");
  } catch (e: any) {
    toast(e.message);
  }
}

async function deleteProject(p: any) {
  if (confirm(`Delete project "${p.name}"? Its conversations stay.`)) {
    try {
      const resp = await api(`/v1/projects/${p.id}`, { method: "DELETE" });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || resp.statusText);
      }
      await loadProjects();
      await loadSessions();
      await fetchData();
      toast("Deleted");
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

    <!-- Error -->
    <p v-if="errorMsg" class="msg err">{{ errorMsg }}</p>

    <p class="muted">
      New conversations in a project start in its directory. Editing or deleting a project does not change existing conversations.
    </p>

    <!-- Add project card -->
    <div class="card grid">
      <b>Add project</b>
      <label class="field-label">
        <span>name</span>
        <input placeholder="name" v-model="newName" />
      </label>
      <label class="field-label">
        <span>/absolute/working/directory</span>
        <input placeholder="/absolute/working/directory" v-model="newCwd" />
      </label>
      <div class="row">
        <button @click="addProject">Add</button>
      </div>
    </div>

    <!-- Loading -->
    <p v-if="loading" class="muted" role="status">Loading…</p>

    <p v-if="!loading && !projects.length" class="muted">No projects yet.</p>

    <div v-for="p in projects" :key="p.id" class="card grid">
      <label class="field-label">
        <span>Project name</span>
        <input aria-label="Project name" v-model="editNames[p.id]" />
      </label>
      <label class="field-label">
        <span>Working directory</span>
        <input aria-label="Working directory" v-model="editCwds[p.id]" />
      </label>
      <div class="row">
        <button @click="saveProject(p)">Save</button>
        <button style="color:var(--err)" @click="deleteProject(p)">Delete</button>
      </div>
    </div>
  </div>
</template>
