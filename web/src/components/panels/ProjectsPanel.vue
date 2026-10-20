<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from "vue";
import { ChevronLeft, Plus } from "@lucide/vue";
import { api, post } from "@/lib/api";
import { useMobile } from "@/lib/dom";
import { history, loadProjects, loadSessions, sessionTitle } from "@/stores/sessions";
import { chat, newSession, openSession } from "@/stores/chat";
import { closePanel } from "@/stores/app";
import type { Project, SessionMeta } from "@/lib/types";

const mobile = useMobile();
const loading = ref(true);
const errorMsg = ref("");
const notice = ref("");
const filter = ref("");
/** Selected project id, "new" for the create form, or null for none. */
const selected = ref<number | "new" | null>(null);
/** Mobile shows one pane at a time. */
const showDetail = ref(false);
const name = ref("");
const cwd = ref("");
const busy = ref(false);

const visible = (s: SessionMeta) => !s.archived;
const sessionsOf = (id: number) => history.list.filter(s => visible(s) && Number(s.project) === id);
const count = (id: number) => sessionsOf(id).length;

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return q ? history.projects.filter(p => p.name.toLowerCase().includes(q) || p.cwd.toLowerCase().includes(q)) : history.projects;
});
const current = computed<Project | null>(() => typeof selected.value === "number" ? history.projects.find(p => p.id === selected.value) ?? null : null);
const recent = computed(() => current.value ? sessionsOf(current.value.id).slice(0, 5) : []);
const dirty = computed(() => selected.value === "new"
  ? !!name.value.trim() && !!cwd.value.trim()
  : !!current.value && (name.value !== current.value.name || cwd.value.trim() !== current.value.cwd));

function ago(ms?: number | null) {
  if (!ms) return "";
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function select(id: number | "new" | null) {
  selected.value = id;
  notice.value = "";
  const p = typeof id === "number" ? history.projects.find(x => x.id === id) : null;
  name.value = p?.name ?? "";
  cwd.value = p?.cwd ?? "";
  if (id !== null) showDetail.value = true;
  if (id === "new") void nextTick(() => document.getElementById("project-name")?.focus());
}

async function refresh() {
  await loadProjects();
  await loadSessions().catch(() => {});
}

async function run(action: () => Promise<void>) {
  busy.value = true; notice.value = "";
  try { await action(); } catch (e) { notice.value = (e as Error).message; } finally { busy.value = false; }
}

const save = () => run(async () => {
  if (selected.value === "new") {
    const created = await post<{ id: number }>("/v1/projects", { name: name.value.trim(), cwd: cwd.value.trim() });
    await refresh();
    select(created.id);
    notice.value = "Project added";
  } else if (current.value) {
    await post(`/v1/projects/${current.value.id}`, { name: name.value.trim(), cwd: cwd.value.trim() }, "PATCH");
    await refresh();
    select(current.value.id);
    notice.value = "Saved";
  }
});

const remove = () => run(async () => {
  const p = current.value;
  if (!p || !confirm(`Delete project "${p.name}"? Its conversations stay.`)) return;
  const resp = await api(`/v1/projects/${p.id}`, { method: "DELETE" });
  if (!resp.ok) throw new Error(((await resp.json().catch(() => ({}))) as { error?: string }).error || resp.statusText);
  await refresh();
  select(history.projects[0]?.id ?? null);
  showDetail.value = false;
});

const startChat = () => run(async () => {
  const p = current.value;
  if (!p) return;
  closePanel();
  await newSession(p.id);
  void nextTick(() => document.querySelector<HTMLTextAreaElement>("#input")?.focus());
});

function openChat(s: SessionMeta) {
  closePanel();
  void openSession(s.id);
}

// Keep the selection valid when the list changes elsewhere.
watch(() => history.projects, list => {
  if (typeof selected.value === "number" && !list.some(p => p.id === selected.value)) select(list[0]?.id ?? null);
});

onMounted(async () => {
  try { await refresh(); } catch (e) { errorMsg.value = (e as Error).message; }
  loading.value = false;
  const active = Number(chat.project ?? localStorage.getItem("luna.project"));
  const start = history.projects.find(p => p.id === active) ?? history.projects[0];
  select(start ? start.id : "new");
  showDetail.value = false;
});
</script>

<template>
  <div class="pw" :class="{ 'pw-detail': showDetail }">
    <aside class="pw-list" aria-label="Projects">
      <div class="pw-filter"><input v-model="filter" aria-label="Filter projects" placeholder="Filter projects" /></div>
      <div class="pw-items" role="list">
        <p v-if="loading" class="pw-muted" role="status">Loading…</p>
        <p v-else-if="errorMsg" class="pw-err">{{ errorMsg }}</p>
        <p v-else-if="!history.projects.length" class="pw-muted">No projects yet.</p>
        <p v-else-if="!filtered.length" class="pw-muted">No match.</p>
        <button
          v-for="p in filtered" :key="p.id" role="listitem" class="pw-item" :data-project="p.id"
          :aria-current="selected === p.id ? 'true' : undefined" @click="select(p.id)"
        >
          <span class="pw-item-name">{{ p.name }}</span>
          <span class="pw-count" :title="`${count(p.id)} conversations`">{{ count(p.id) }}</span>
        </button>
      </div>
      <div class="pw-foot">
        <button id="project-new" class="pw-btn pw-wide" :aria-pressed="selected === 'new'" @click="select('new')"><Plus :size="14" /> New project</button>
      </div>
    </aside>

    <section class="pw-main">
      <button v-if="mobile" class="pw-back" aria-label="Back to projects" @click="showDetail = false"><ChevronLeft :size="16" /> Projects</button>

      <template v-if="selected === 'new' || current">
        <h3 class="pw-title">{{ selected === 'new' ? 'New project' : current!.name }}</h3>
        <p v-if="selected === 'new'" class="pw-muted">New conversations in a project start in its directory.</p>

        <form class="pw-sec" @submit.prevent="save">
          <h4 v-if="selected !== 'new'">Settings</h4>
          <label class="pw-field">Name<input id="project-name" v-model="name" aria-label="Project name" autocomplete="off" /></label>
          <label class="pw-field">Working directory<input v-model="cwd" class="pw-mono" aria-label="Working directory" placeholder="/absolute/working/directory" autocomplete="off" spellcheck="false" /></label>
          <div class="pw-row">
            <button type="submit" class="pw-btn pw-primary" :disabled="!dirty || busy">{{ selected === 'new' ? 'Add project' : 'Save' }}</button>
            <span v-if="notice" class="pw-muted" role="status">{{ notice }}</span>
          </div>
          <p v-if="selected !== 'new'" class="pw-muted pw-small">Changes apply to new conversations only.</p>
        </form>

        <div v-if="current" class="pw-sec">
          <h4>Recent conversations</h4>
          <p v-if="!recent.length" class="pw-muted">No conversations yet.</p>
          <button v-for="s in recent" :key="s.id" class="pw-conv" @click="openChat(s)">
            <span class="pw-conv-title">{{ sessionTitle(s) }}</span>
            <span class="pw-muted">{{ ago(s.lastActivity ?? s.createdAt) }}</span>
          </button>
          <div><button id="project-chat" class="pw-btn" :disabled="busy" @click="startChat"><Plus :size="14" /> New chat in {{ current.name }}</button></div>
        </div>

        <div v-if="current" class="pw-danger">
          <p>Delete this project. Its conversations stay.</p>
          <button class="pw-btn pw-del" :disabled="busy" @click="remove">Delete</button>
        </div>
      </template>
      <p v-else class="pw-muted">Select a project.</p>
    </section>
  </div>
</template>

<style scoped>
.pw { display: flex; height: 100%; min-height: 0; }
.pw-list { width: 260px; flex-shrink: 0; display: flex; flex-direction: column; border-right: 1px solid var(--border); background: var(--sidebar); min-height: 0; }
.pw-filter { padding: 10px; }
.pw-items { flex: 1; overflow: auto; padding: 0 6px; display: grid; align-content: start; gap: 2px; }
.pw-item { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border-radius: 7px; text-align: left; background: transparent; border: 0; color: inherit; cursor: pointer; min-width: 0; }
.pw-item:hover { background: var(--sidebar-accent); }
.pw-item[aria-current] { background: var(--acc-soft); color: var(--primary); }
.pw-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pw-count { font-size: 11.5px; color: var(--muted-foreground); background: var(--muted); border-radius: 999px; padding: 1px 8px; }
.pw-foot { padding: 10px; border-top: 1px solid var(--border); }
.pw-main { flex: 1; min-width: 0; overflow: auto; padding: 22px 26px; display: grid; gap: 22px; align-content: start; }
.pw-title { margin: 0; font-size: 17px; font-weight: 600; overflow-wrap: anywhere; }
.pw-sec { display: grid; gap: 10px; }
.pw-sec h4 { margin: 0; font-size: 11.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted-foreground); font-weight: 600; }
.pw-field { display: grid; gap: 6px; font-size: 12px; color: var(--muted-foreground); }
input { width: 100%; min-width: 0; border: 1px solid var(--input); background: var(--background); color: var(--foreground); border-radius: 7px; padding: 8px 10px; font-size: 13px; outline: none; }
input:focus { border-color: var(--ring); }
.pw-mono { font-family: var(--mono); font-size: 12.5px; }
.pw-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pw-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 12px; border: 1px solid var(--border); background: var(--secondary); color: var(--foreground); border-radius: 7px; font-size: 13px; cursor: pointer; }
.pw-btn:hover:not(:disabled) { border-color: var(--muted-foreground); }
.pw-btn:disabled { opacity: .45; cursor: default; }
.pw-wide { width: 100%; }
.pw-primary { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); font-weight: 600; }
.pw-primary:hover:not(:disabled) { border-color: var(--primary); filter: brightness(1.08); }
.pw-del { color: var(--destructive); }
.pw-conv { display: flex; justify-content: space-between; gap: 12px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 7px; background: transparent; color: inherit; font-size: 13px; text-align: left; cursor: pointer; min-width: 0; }
.pw-conv:hover { background: var(--secondary); }
.pw-conv-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pw-danger { border: 1px solid rgb(248 113 113 / .25); border-radius: 9px; padding: 12px 14px; display: flex; align-items: center; gap: 12px; }
.pw-danger p { margin: 0; flex: 1; font-size: 12.5px; color: var(--muted-foreground); }
.pw-muted { margin: 0; color: var(--muted-foreground); font-size: 12.5px; }
.pw-small { font-size: 11.5px; }
.pw-items > .pw-muted, .pw-items > .pw-err { padding: 8px 10px; }
.pw-err { margin: 0; color: var(--destructive); font-size: 12.5px; }
.pw-back { display: inline-flex; align-items: center; gap: 4px; justify-self: start; background: transparent; border: 0; color: var(--muted-foreground); font-size: 13px; padding: 0; cursor: pointer; }
@media (max-width: 760px) {
  .pw-list { width: 100%; border-right: 0; }
  .pw-main { display: none; padding: 16px; }
  .pw-detail .pw-list { display: none; }
  .pw-detail .pw-main { display: grid; }
}
</style>
