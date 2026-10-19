<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { json, post } from "@/lib/api";

type Evidence = { id: number; kind: string; session: number; message: number; summary: string; ts: number | null };
type Lesson = {
  id: number; claim: string; cause: string | null; scope: "skill" | "memory"; skill: string | null; status: string;
  proposal: string | null; tests: string[]; fact_key: string | null; note: string | null; needs_guard: boolean;
  failures: number; version: number | null; sessions: number; current: string | null; evidence: Evidence[]; updated: number;
};

const loading = ref(true);
const errorMsg = ref("");
const lessons = ref<Lesson[]>([]);
const unassigned = ref(0);
const busy = ref<number | "scan" | null>(null);
const open = ref<Record<number, boolean>>({});
const showHistory = ref(false);

async function load() {
  errorMsg.value = "";
  try {
    const r = await json("/v1/lessons");
    lessons.value = r.lessons || [];
    unassigned.value = r.unassigned || 0;
  } catch (e: any) {
    if (e.message !== "unauthorized") errorMsg.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function act(l: Lesson, action: "approve" | "reject" | "rollback") {
  let body: Record<string, string> = {};
  if (action === "reject") {
    const note = prompt("Why reject? Luna will not propose this lesson again.", "");
    if (note === null) return;
    body = { note };
  }
  if (action === "rollback" && !confirm(`Restore ${l.skill} to the version before this lesson?`)) return;
  busy.value = l.id;
  errorMsg.value = "";
  try { await post(`/v1/lessons/${l.id}/${action}`, body); await load(); }
  catch (e: any) { errorMsg.value = e.message; }
  finally { busy.value = null; }
}

async function scan() {
  busy.value = "scan";
  try { await post("/v1/lessons/scan"); await load(); }
  catch (e: any) { errorMsg.value = e.message; }
  finally { busy.value = null; }
}

const groups = computed(() => [
  { id: "review", title: "Needs review", items: lessons.value.filter((l) => l.status === "proposed") },
  { id: "guard", title: "Needs a code guard", hint: "Text did not fix these. They need a tool check or policy in code.", items: lessons.value.filter((l) => l.needs_guard && !["rejected", "retired", "proposed"].includes(l.status)) },
  { id: "watch", title: "Applied", hint: "Checked against later sessions.", items: lessons.value.filter((l) => ["applied", "confirmed", "ineffective"].includes(l.status) && !l.needs_guard) },
  { id: "evidence", title: "Collecting evidence", hint: "A lesson needs 2+ sessions or an explicit rule from you.", items: lessons.value.filter((l) => ["candidate", "corroborated"].includes(l.status) && !l.needs_guard) },
]);
const history = computed(() => lessons.value.filter((l) => ["rejected", "retired"].includes(l.status)));

/** Line diff (LCS) between the current skill and the proposal. Skills are capped at 20k chars, so O(n*m) is fine. */
function diff(a: string, b: string): { t: " " | "-" | "+"; s: string }[] {
  const x = a.split("\n"), y = b.split("\n");
  const n = x.length, m = y.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: { t: " " | "-" | "+"; s: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ t: " ", s: x[i]! }); i++; j++; }
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) out.push({ t: "-", s: x[i++]! });
    else out.push({ t: "+", s: y[j++]! });
  }
  while (i < n) out.push({ t: "-", s: x[i++]! });
  while (j < m) out.push({ t: "+", s: y[j++]! });
  return out;
}

const when = (ts: number | null) => (ts ? new Date(ts).toLocaleString() : "");
const CAUSES: Record<string, string> = { missing: "rule was missing", not_loaded: "skill was not loaded", ignored: "rule was ignored", wrong: "rule was wrong" };

onMounted(load);
</script>

<template>
  <div class="grid">
    <div class="row">
      <span class="muted grow">{{ unassigned }} signal{{ unassigned === 1 ? "" : "s" }} waiting for the daily pass</span>
      <button :disabled="busy !== null" @click="scan">{{ busy === "scan" ? "Scanning…" : "Scan idle sessions" }}</button>
    </div>
    <p v-if="loading" class="muted" role="status">Loading…</p>
    <p v-if="errorMsg" class="msg err" role="alert">{{ errorMsg }}</p>
    <p v-if="!loading && !lessons.length" class="muted">No lessons yet. Luna scans each conversation after it goes idle.</p>

    <section v-for="g in groups" v-show="g.items.length" :key="g.id" class="grid" :data-group="g.id">
      <div>
        <b>{{ g.title }}</b> <span class="muted">({{ g.items.length }})</span>
        <div v-if="g.hint" class="muted text-xs">{{ g.hint }}</div>
      </div>
      <div v-for="l in g.items" :key="l.id" class="card grid" :data-lesson="l.id">
        <div class="row">
          <span class="pill">{{ l.status }}</span>
          <b class="grow">{{ l.claim }}</b>
        </div>
        <div class="muted text-xs">
          {{ l.scope === "memory" ? "memory" : l.skill ? `skill ${l.skill}` : "no target yet" }}
          <template v-if="l.cause"> · {{ CAUSES[l.cause] ?? l.cause }}</template>
          · {{ l.sessions }} session{{ l.sessions === 1 ? "" : "s" }}
          <template v-if="l.failures"> · failed {{ l.failures }}×</template>
        </div>

        <template v-if="l.status === 'proposed'">
          <pre v-if="l.scope === 'memory'" class="lesson-diff"><span class="add">+ {{ l.fact_key ? `${l.fact_key}: ` : "" }}{{ l.proposal }}</span></pre>
          <pre v-else class="lesson-diff"><span v-for="(d, i) in diff(l.current ?? '', l.proposal ?? '')" :key="i" :class="{ add: d.t === '+', del: d.t === '-' }">{{ d.t }} {{ d.s }}
</span></pre>
          <div v-if="l.tests.length" class="muted text-xs">Regression check: must contain {{ l.tests.map((t) => `"${t}"`).join(", ") }}</div>
        </template>

        <button class="link-button" @click="open[l.id] = !open[l.id]">{{ open[l.id] ? "Hide evidence" : `Evidence (${l.evidence.length})` }}</button>
        <ul v-if="open[l.id]" class="evidence">
          <li v-for="e in l.evidence" :key="e.id"><span class="muted">{{ e.kind }} · session {{ e.session }} · message {{ e.message }} · {{ when(e.ts) }}</span><br>{{ e.summary }}</li>
        </ul>

        <div class="row">
          <template v-if="l.status === 'proposed'">
            <button :disabled="busy !== null" @click="act(l, 'approve')">Approve</button>
            <button :disabled="busy !== null" @click="act(l, 'reject')">Reject</button>
          </template>
          <button v-else-if="['applied', 'confirmed', 'ineffective'].includes(l.status) && l.scope === 'skill' && l.version !== null" :disabled="busy !== null" @click="act(l, 'rollback')">Roll back</button>
          <button v-if="['candidate', 'corroborated', 'ineffective'].includes(l.status) || (l.needs_guard && l.status !== 'proposed')" :disabled="busy !== null" @click="act(l, 'reject')">Dismiss</button>
        </div>
      </div>
    </section>

    <section v-if="history.length" class="grid">
      <button class="link-button" @click="showHistory = !showHistory">{{ showHistory ? "Hide" : "Show" }} rejected and retired ({{ history.length }})</button>
      <div v-for="l in showHistory ? history : []" :key="l.id" class="card" :data-lesson="l.id">
        <div class="row"><span class="pill">{{ l.status }}</span><span class="grow">{{ l.claim }}</span></div>
        <div v-if="l.note" class="muted text-xs">{{ l.note }}</div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.lesson-diff { max-height: 320px; overflow: auto; font-size: 12px; white-space: pre-wrap; }
.lesson-diff span { display: block; }
.lesson-diff .add { color: var(--color-green-500, #3fb950); }
.lesson-diff .del { color: var(--color-red-500, #f85149); text-decoration: line-through; opacity: .8; }
.evidence { margin: 0; padding-left: 1rem; font-size: 12px; display: grid; gap: 6px; }
.link-button { justify-self: start; background: none; border: 0; padding: 0; color: var(--muted-foreground); text-decoration: underline; cursor: pointer; font-size: 12px; }
</style>
