<script setup lang="ts">
import { confirmAction } from "@/lib/confirm";
import { ref, reactive, computed, watch, defineAsyncComponent, onMounted, nextTick } from "vue";
import { ChevronLeft, Plus, RotateCcw, Star, Palette } from "@lucide/vue";
import { api, post } from "@/lib/api";
import { useMobile } from "@/lib/dom";
import { history, loadProjects, loadSessions, sessionTitle, toggleFavorite } from "@/stores/sessions";
import { chat, newSession, openSession } from "@/stores/chat";
import { closePanel } from "@/stores/app";
import { loadWorkers, workers } from "@/stores/workers";
import type { Project, SessionMeta } from "@/lib/types";
import { sortProjects } from "@/lib/projects";
import ProjectIcon from "@/components/ProjectIcon.vue";
const ProjectAppearanceDialog = defineAsyncComponent(() => import("@/components/ProjectAppearanceDialog.vue"));
const appearanceProject = ref<number | null>(null);

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
const createOn = ref<"host" | "worker" | "both">("host");
const newWorker = ref<number | null>(null);
const newWorkerCwd = ref("");
const busy = ref(false);

const visible = (s: SessionMeta) => !s.archived;
const sessionsOf = (id: number) => history.list.filter(s => visible(s) && Number(s.project) === id);
const count = (id: number) => sessionsOf(id).length;

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const list = sortProjects(history.projects);
  return q ? list.filter(p => p.name.toLowerCase().includes(q) || p.cwd.toLowerCase().includes(q)) : list;
});
const current = computed<Project | null>(() => typeof selected.value === "number" ? history.projects.find(p => p.id === selected.value) ?? null : null);
const recent = computed(() => current.value ? sessionsOf(current.value.id).slice(0, 5) : []);
const dirty = computed(() => {
  if (selected.value === "new") {
    const workerOnly = newWorker.value !== null && !!newWorkerCwd.value.trim();
    return !!name.value.trim() && (createOn.value === "worker" || !!cwd.value.trim()) && (createOn.value === "host" || workerOnly);
  }
  return !!current.value && (name.value !== current.value.name || cwd.value.trim() !== current.value.cwd);
});

/** Directory per machine for the selected project. Linking a machine makes it use this project's board. */
const machineDirs = reactive<Record<number, string>>({});
const linkedDir = (worker: number) => current.value?.workerDirs?.find(d => d.worker === worker)?.cwd;
function syncMachineDirs() {
  for (const k of Object.keys(machineDirs)) delete machineDirs[Number(k)];
  for (const w of workers.list) machineDirs[w.id] = linkedDir(w.id) ?? "";
}
const linkMachine = (worker: number) => run(async () => {
  const p = current.value; if (!p) return;
  await post(`/v1/projects/${p.id}/machines/${worker}`, { cwd: (machineDirs[worker] ?? "").trim() }, "PUT");
  await refresh(); syncMachineDirs(); notice.value = "Saved";
});
/** Machines the project is on. The last one cannot be removed; deleting the project is what deletes the board. */
const machineCount = computed(() => (current.value?.cwd ? 1 : 0) + (current.value?.workerDirs?.length ?? 0));
const unlinkMachine = (worker: number | "main") => run(async () => {
  const p = current.value; if (!p) return;
  const resp = await api(`/v1/projects/${p.id}/machines/${worker}`, { method: "DELETE" });
  if (!resp.ok) throw new Error(((await resp.json().catch(() => ({}))) as { error?: string }).error || resp.statusText);
  await refresh();
  if (worker === "main") cwd.value = "";
  syncMachineDirs(); notice.value = "Removed";
});

/** Per-project skill overrides. `override` null means the skill follows the global setting. */
type ProjectSkill = { name: string; description: string; global: boolean; override: boolean | null; effective: boolean };
const skills = ref<ProjectSkill[]>([]);
const skillsError = ref("");
const skillFilter = ref("");
const skillStatus = ref<"all" | "enabled" | "disabled">("all");
const skillBusy = reactive<Record<string, boolean>>({});
const shownSkills = computed(() => {
  const q = skillFilter.value.trim().toLowerCase();
  return skills.value.filter(s =>
    (skillStatus.value === "all" || s.effective === (skillStatus.value === "enabled")) &&
    (!q || `${s.name} ${s.description}`.toLowerCase().includes(q))
  );
});
async function loadSkills(id: number) {
  skillsError.value = "";
  try {
    const list = await api(`/v1/projects/${id}/skills`).then(async r => {
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || r.statusText);
      return r.json() as Promise<ProjectSkill[]>;
    });
    if (selected.value === id) skills.value = list;
  } catch (e) { if (selected.value === id) { skills.value = []; skillsError.value = (e as Error).message; } }
}
/** `enabled` null resets to global. Optimistic; rolls back on failure. The guard is released on every path. */
async function setSkill(s: ProjectSkill, enabled: boolean | null) {
  const p = current.value; if (!p || skillBusy[s.name]) return;
  skillBusy[s.name] = true;
  const before = { override: s.override, effective: s.effective };
  s.override = enabled; s.effective = enabled ?? s.global;
  skillsError.value = "";
  try { await post(`/v1/projects/${p.id}/skills/${encodeURIComponent(s.name)}`, { enabled }, "PUT"); }
  catch (e) { s.override = before.override; s.effective = before.effective; skillsError.value = (e as Error).message; }
  finally { skillBusy[s.name] = false; }
}

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
  if (id === "new") { createOn.value = "host"; newWorker.value = null; newWorkerCwd.value = ""; }
  syncMachineDirs();
  skills.value = []; skillFilter.value = ""; skillStatus.value = "all"; skillsError.value = "";
  if (typeof id === "number" && id !== 0) void loadSkills(id);
  if (id !== null) showDetail.value = true;
  if (id === "new") void nextTick(() => document.getElementById("project-name")?.focus());
}

async function refresh(force = true) {
  await loadProjects({ force });
  await loadSessions().catch(() => {});
}

async function run(action: () => Promise<void>) {
  busy.value = true; notice.value = "";
  try { await action(); } catch (e) { notice.value = (e as Error).message; } finally { busy.value = false; }
}

const save = () => run(async () => {
  if (selected.value === "new") {
    const hostCwd = createOn.value === "worker" ? "" : cwd.value.trim();
    const payload: Record<string, unknown> = { name: name.value.trim(), cwd: hostCwd };
    if (createOn.value !== "host" && newWorker.value !== null && newWorkerCwd.value.trim()) { payload.worker = newWorker.value; payload.workerCwd = newWorkerCwd.value.trim(); }
    if (createOn.value !== "host" && (newWorker.value === null || !newWorkerCwd.value.trim())) { notice.value = "Select a worker and enter its directory"; return; }
    if (createOn.value !== "worker" && !hostCwd) { notice.value = "Enter a main host directory"; return; }
    const created = await post<{ id: number }>("/v1/projects", payload);
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
  if (!p) return;
  const cards = ((await api(`/v1/projects/${p.id}/board`).then(r => r.json()).catch(() => ({ cards: [] }))) as { cards?: unknown[] }).cards?.length ?? 0;
  const where = machineCount.value > 1 ? ` on all ${machineCount.value} machines` : "";
  if (!(await confirmAction({ title: `Delete project "${p.name}"${where}?`, message: `This deletes its board (${cards} card${cards === 1 ? "" : "s"}). Its conversations stay. To keep the board for other machines, remove only this machine instead.`, confirmLabel: "Delete", danger: true }))) return;
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
  try { await Promise.all([refresh(false), loadWorkers().catch(() => [])]); } catch (e) { errorMsg.value = (e as Error).message; }
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
      <div class="pw-filter"><input dir="auto" v-model="filter" aria-label="Filter projects" placeholder="Filter projects" /></div>
      <div class="pw-items" role="list">
        <p v-if="loading" class="pw-muted" role="status">Loading…</p>
        <p v-else-if="errorMsg" class="pw-err">{{ errorMsg }}</p>
        <p v-else-if="!history.projects.length" class="pw-muted">No projects yet.</p>
        <p v-else-if="!filtered.length" class="pw-muted">No match.</p>
        <button
          v-for="p in filtered" :key="p.id" role="listitem" class="pw-item vl vl-sm" :data-project="p.id"
          :aria-current="selected === p.id ? 'true' : undefined" @click="select(p.id)"
        >
          <ProjectIcon :icon="p.icon" :color="p.color" />
          <span dir="auto" class="pw-item-name">{{ p.name }}</span>
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
        <div class="pw-head">
          <ProjectIcon v-if="current" :icon="current.icon" :color="current.color" :size="20" />
          <h3 dir="auto" class="pw-title">{{ selected === 'new' ? 'New project' : current!.name }}</h3>
          <button v-if="current && !current.general" type="button" class="pw-btn pw-star" :aria-pressed="!!current.favorite" :title="current.favorite ? 'Unfavourite' : 'Favourite'" :aria-label="current.favorite ? 'Unfavourite project' : 'Favourite project'" @click="toggleFavorite(current.id)"><Star :size="14" :fill="current.favorite ? 'currentColor' : 'none'" /></button>
        </div>
        <p v-if="selected === 'new'" class="pw-muted">New conversations in a project start in its directory.</p>

        <div v-if="current" class="pw-row"><button type="button" class="pw-btn" @click="appearanceProject = current.id"><Palette :size="14" /> Appearance</button></div>
        <p v-if="current?.general" class="pw-muted">General shares a board across Chats. Each conversation keeps its working directory.</p>
        <form v-else class="pw-sec" @submit.prevent="save">
          <h4 v-if="selected !== 'new'">Settings</h4>
          <label class="pw-field">Name<input dir="auto" id="project-name" v-model="name" aria-label="Project name" autocomplete="off" /></label>
          <label v-if="selected === 'new'" class="pw-field">Create on<select v-model="createOn" class="pw-input" aria-label="Create project on"><option value="host">Host</option><option value="worker">Worker</option><option value="both">Both</option></select></label>
          <label v-if="selected !== 'new' || createOn !== 'worker'" class="pw-field">Main host directory<input v-model="cwd" class="pw-mono" aria-label="Working directory" placeholder="/absolute/working/directory" autocomplete="off" spellcheck="false" /></label>
          <template v-if="selected === 'new' && createOn !== 'host'">
            <label class="pw-field">Worker<select v-model="newWorker" class="pw-input" aria-label="Worker for new project"><option :value="null" disabled>Select a worker</option><option v-for="w in workers.list" :key="w.id" :value="w.id">{{ w.name }}{{ w.online ? "" : " · Offline" }}</option></select></label>
            <p v-if="!workers.list.length" class="pw-muted pw-small">Register a worker before creating a project on it.</p>
            <label class="pw-field">Worker directory<input v-model="newWorkerCwd" class="pw-mono" aria-label="Directory on worker" placeholder="/absolute/path/on/worker" autocomplete="off" spellcheck="false" /></label>
          </template>
          <div class="pw-row">
            <button type="submit" class="pw-btn pw-primary" :disabled="!dirty || busy">{{ selected === 'new' ? 'Add project' : 'Save' }}</button>
            <span v-if="notice" class="pw-muted" role="status">{{ notice }}</span>
          </div>
          <p v-if="selected !== 'new'" class="pw-muted pw-small">Changes apply to new conversations only.</p>
        </form>

        <div v-if="current && !current.general && workers.list.length" class="pw-sec" id="project-machines">
          <h4>Machines</h4>
          <p class="pw-muted pw-small">Every linked machine uses this project's board. Removing a machine leaves the board and the other machines unchanged.</p>
          <div class="pw-machine pw-host">
            <span class="pw-machine-name">This host</span>
            <span class="pw-mono pw-muted">{{ current.cwd || "Not on this host" }}</span>
            <button v-if="current.cwd" type="button" class="pw-btn" :disabled="busy || machineCount < 2" :title="machineCount < 2 ? 'Last machine. Delete the project instead.' : 'Remove from this host. Other machines keep the board.'" @click="unlinkMachine('main')">Remove</button>
          </div>
          <form v-for="w in workers.list" :key="w.id" class="pw-machine" :data-machine="w.id" @submit.prevent="linkMachine(w.id)">
            <span class="pw-machine-name" :class="{ 'pw-muted': !w.online }">{{ w.name }}<template v-if="!w.online"> · Offline</template></span>
            <input v-model="machineDirs[w.id]" class="pw-mono" :aria-label="'Directory on ' + w.name" placeholder="/absolute/path on this machine" autocomplete="off" spellcheck="false" />
            <button type="submit" class="pw-btn" :disabled="busy || !(machineDirs[w.id] ?? '').trim() || (machineDirs[w.id] ?? '').trim() === linkedDir(w.id)">{{ linkedDir(w.id) ? 'Save' : 'Link' }}</button>
            <button v-if="linkedDir(w.id)" type="button" class="pw-btn" :disabled="busy || machineCount < 2" :title="machineCount < 2 ? 'Last machine. Delete the project instead.' : 'Remove from this machine. Other machines keep the board.'" @click="unlinkMachine(w.id)">Remove</button>
          </form>
        </div>

        <div v-if="current && !current.general" class="pw-sec" id="project-skills">
          <h4>Skills</h4>
          <p class="pw-muted pw-small">Switch a skill on or off for this project's conversations. Skills without a custom marker follow the global setting.</p>
          <div class="pw-skill-filters">
            <input v-if="skills.length > 10" v-model="skillFilter" type="search" aria-label="Filter skills" placeholder="Filter skills" autocomplete="off" />
            <select v-model="skillStatus" class="pw-input" aria-label="Filter skills by status">
              <option value="all">All</option>
              <option value="enabled">Enabled</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>
          <p v-if="skillsError" class="pw-err" role="alert">{{ skillsError }}</p>
          <div v-for="s in shownSkills" :key="s.name" class="pw-skill" :data-skill="s.name">
            <div class="pw-skill-text">
              <span class="pw-skill-name">{{ s.name }}<span v-if="s.override !== null" class="pw-custom">custom</span></span>
              <span v-if="s.description" class="pw-muted pw-small pw-skill-desc">{{ s.description }}</span>
            </div>
            <button v-if="s.override !== null" type="button" class="pw-icon" :disabled="skillBusy[s.name]" aria-label="Reset to global" title="Reset to global" @click="setSkill(s, null)"><RotateCcw :size="14" /></button>
            <button type="button" role="switch" class="pw-switch" :aria-checked="s.effective" :aria-label="s.name" :disabled="skillBusy[s.name]" @click="setSkill(s, !s.effective)"><span class="pw-thumb" /></button>
          </div>
          <p v-if="skills.length && !shownSkills.length" class="pw-muted">No match.</p>
        </div>

        <div v-if="current" class="pw-sec">
          <h4>Recent conversations</h4>
          <p v-if="!recent.length" class="pw-muted">No conversations yet.</p>
          <button v-for="s in recent" :key="s.id" class="pw-conv" @click="openChat(s)">
            <span dir="auto" class="pw-conv-title">{{ sessionTitle(s) }}</span>
            <span class="pw-muted">{{ ago(s.lastActivity ?? s.createdAt) }}</span>
          </button>
          <div><button id="project-chat" class="pw-btn" :disabled="busy" @click="startChat"><Plus :size="14" /> New chat in {{ current.name }}</button></div>
        </div>

        <div v-if="current && !current.general" class="pw-danger">
          <p>Delete this project and its board on every machine. Its conversations stay.</p>
          <button class="pw-btn pw-del" :disabled="busy" @click="remove">Delete</button>
        </div>
      </template>
      <p v-else class="pw-muted">Select a project.</p>
    </section>
    <ProjectAppearanceDialog v-if="appearanceProject !== null" :project-id="appearanceProject" @close="appearanceProject = null" />
  </div>
</template>

<style scoped>
.pw { display: flex; height: 100%; min-height: 0; }
.pw-list { width: 260px; flex-shrink: 0; display: flex; flex-direction: column; border-right: 1px solid var(--border); background: var(--sidebar); min-height: 0; }
.pw-filter { padding: 10px; }
.pw-items { flex: 1; overflow: auto; padding: 0 6px; display: grid; align-content: start; gap: 2px; }
.pw-item { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border-radius: var(--radius); text-align: left; background: transparent; border: 0; color: inherit; cursor: pointer; min-width: 0; }
.pw-item:hover { background: var(--sidebar-accent); }
.pw-item[aria-current] { background: var(--acc-soft); color: var(--primary-text); }
.pw-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pw-count { font-size: 12.5px; color: var(--muted-foreground); background: var(--muted); border-radius: var(--radius); padding: 1px 8px; }
.pw-foot { padding: 10px; border-top: 1px solid var(--border); }
.pw-main { flex: 1; min-width: 0; overflow: auto; padding: 22px 26px; display: grid; gap: 22px; align-content: start; }
.pw-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.pw-star { flex-shrink: 0; padding: 6px 8px; }
.pw-title { margin: 0; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
.pw-sec { display: grid; gap: 10px; }
.pw-sec h4 { margin: 0; font-size: 12.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted-foreground); font-weight: 600; }
.pw-machine { display: grid; grid-template-columns: 120px minmax(0, 1fr) auto auto; align-items: center; gap: 8px; }
.pw-host { grid-template-columns: 120px minmax(0, 1fr) auto; }
.pw-machine-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.pw-field { display: grid; gap: 6px; font-size: 13px; color: var(--muted-foreground); }
input, select.pw-input { width: 100%; min-width: 0; border: 1px solid var(--input); background: var(--background); color: var(--foreground); border-radius: var(--radius); padding: 8px 10px; font-size: 14px; outline: none; }
input:focus, select.pw-input:focus { border-color: var(--ring); }
.pw-mono { font-family: var(--mono); font-size: 13.5px; }
.pw-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pw-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 12px; border: 1px solid var(--border); background: var(--secondary); color: var(--foreground); border-radius: var(--radius); font-size: 14px; cursor: pointer; }
.pw-btn:hover:not(:disabled) { border-color: var(--muted-foreground); }
.pw-btn:disabled { opacity: .45; cursor: default; }
.pw-wide { width: 100%; }
.pw-primary { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); font-weight: 600; }
.pw-primary:hover:not(:disabled) { border-color: var(--primary); filter: brightness(1.08); }
.pw-del { color: var(--destructive); }
.pw-skill-filters { display: flex; align-items: center; gap: 8px; }
.pw-skill-filters input { flex: 1; }
.pw-skill-filters select { width: auto; flex-shrink: 0; }
.pw-skill { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.pw-skill-text { flex: 1; min-width: 0; display: grid; gap: 2px; }
.pw-skill-name { font-size: 14px; overflow-wrap: anywhere; }
.pw-skill-desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pw-custom { margin-left: 8px; font-size: 12px; color: var(--primary-text); background: var(--acc-soft); border-radius: var(--radius); padding: 1px 6px; }
.pw-icon { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 1px solid var(--border); background: transparent; color: var(--muted-foreground); border-radius: var(--radius); cursor: pointer; }
.pw-icon:hover:not(:disabled) { color: var(--foreground); border-color: var(--muted-foreground); }
.pw-icon:disabled, .pw-switch:disabled { opacity: .45; cursor: default; }
.pw-switch { position: relative; flex-shrink: 0; width: 34px; height: 20px; border-radius: 999px; border: 1px solid var(--border); background: var(--muted); cursor: pointer; padding: 0; }
.pw-switch[aria-checked="true"] { background: var(--primary); border-color: var(--primary); }
.pw-thumb { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--foreground); transition: transform .12s; }
.pw-switch[aria-checked="true"] .pw-thumb { transform: translateX(14px); background: var(--primary-foreground); }
.pw-conv { display: flex; justify-content: space-between; gap: 12px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius); background: transparent; color: inherit; font-size: 14px; text-align: left; cursor: pointer; min-width: 0; }
.pw-conv:hover { background: var(--secondary); }
.pw-conv-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pw-danger { border: 1px solid rgb(248 113 113 / .25); border-radius: var(--radius); padding: 12px 14px; display: flex; align-items: center; gap: 12px; }
.pw-danger p { margin: 0; flex: 1; font-size: 13.5px; color: var(--muted-foreground); }
.pw-muted { margin: 0; color: var(--muted-foreground); font-size: 13.5px; }
.pw-small { font-size: 12.5px; }
.pw-items > .pw-muted, .pw-items > .pw-err { padding: 8px 10px; }
.pw-err { margin: 0; color: var(--destructive); font-size: 13.5px; }
.pw-back { display: inline-flex; align-items: center; gap: 4px; justify-self: start; background: transparent; border: 0; color: var(--muted-foreground); font-size: 14px; padding: 0; cursor: pointer; }
@media (max-width: 760px) {
  .pw-list { width: 100%; border-right: 0; }
  .pw-machine { grid-template-columns: 1fr auto auto; }
  .pw-machine-name, .pw-machine > .pw-mono { grid-column: 1 / -1; }
  .pw-main { display: none; padding: 16px; }
  .pw-detail .pw-list { display: none; }
  .pw-detail .pw-main { display: grid; }
}
</style>
