<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { json, post } from "@/lib/api";

type Evidence = { id: number; kind: string; session: number; message: number; summary: string; ts: number | null; context: { task?: number; action?: number; actionSummary?: string; tools?: string[] } };
type Lesson = {
  id: number; claim: string; cause: string | null; scope: "skill" | "memory" | "user" | "project" | "projection"; skill: string | null; status: string;
  proposal: string | null; tests: string[]; fact_key: string | null; note: string | null; needs_guard: boolean;
  failures: number; version: number | null; sessions: number; current: string | null; evidenceCount?: number; evidence: Evidence[]; updated: number;
  critical: string | null; domain: string; target: string | null; effect: string; currentMatches: boolean | null;
  changes: { id: number; target: string; state: string; before_text: string | null; after_text: string | null }[];
  assessments: { signal: number; role: string; rationale: string }[];
  observations: { id: number; outcome: string; conv: number; entry: number; relevance: string; evidence: string }[];
};

const loading = ref(true);
const errorMsg = ref("");
const lessons = ref<Lesson[]>([]);
const history = ref<Lesson[]>([]);
const historyCount = ref(0);
const historyNextOffset = ref<number | null>(null);
const loadingMoreHistory = ref(false);
const unassigned = ref(0);
const projectionStale = ref(false);
const dueReview = ref<{ id: number; claim: string }[]>([]);
const busy = ref<number | "scan" | null>(null);
const open = ref<Record<number, boolean>>({});
const openHistory = ref<Record<number, boolean>>({});
const loadingHistory = ref<Record<number, boolean>>({});
const showHistory = ref(false);

async function load() {
  errorMsg.value = "";
  try {
    const r = await json("/v1/lessons");
    lessons.value = r.lessons || [];
    historyCount.value = r.historyCount || 0;
    unassigned.value = r.unassigned || 0;
    projectionStale.value = !!r.projection?.stale;
    dueReview.value = r.metrics?.dueReview ?? [];
  } catch (e: any) {
    if (e.message !== "unauthorized") errorMsg.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function loadHistoryPage(offset = 0) {
  loadingMoreHistory.value = true;
  try {
    const r = await json<{ lessons: Lesson[]; historyCount: number; nextOffset: number | null }>(
      `/v1/lessons?history=1&offset=${offset}&limit=20`
    );
    if (offset === 0) {
      history.value = r.lessons || [];
    } else {
      history.value = [...history.value, ...(r.lessons || [])];
    }
    historyCount.value = r.historyCount ?? historyCount.value;
    historyNextOffset.value = r.nextOffset ?? null;
  } catch (e: any) {
    errorMsg.value = e.message;
  } finally {
    loadingMoreHistory.value = false;
  }
}

async function toggleShowHistory() {
  showHistory.value = !showHistory.value;
  if (showHistory.value && !history.value.length && historyCount.value > 0) {
    await loadHistoryPage(0);
  }
}

async function toggleHistoryEvidence(l: Lesson) {
  if (openHistory.value[l.id]) {
    openHistory.value[l.id] = false;
    return;
  }
  if (!l.evidence || !l.evidence.length) {
    loadingHistory.value[l.id] = true;
    try {
      const full = await json<Lesson>(`/v1/lessons/${l.id}`);
      l.evidence = full.evidence || [];
      l.assessments = full.assessments || [];
      l.observations = full.observations || [];
      l.changes = full.changes || [];
      if (full.evidenceCount !== undefined) l.evidenceCount = full.evidenceCount;
    } catch (e: any) {
      errorMsg.value = e.message;
      return;
    } finally {
      loadingHistory.value[l.id] = false;
    }
  }
  openHistory.value[l.id] = true;
}

async function act(l: Lesson, action: "approve" | "reject" | "rollback" | "reconcile" | "verify", observation?: number) {
  let body: Record<string, string | number> = {};
  if (action === "reject") {
    const note = prompt("Why reject? Luna will not propose this lesson again.", "");
    if (note === null) return;
    body = { note };
  }
  if (action === "approve" && !confirm("Apply this exact proposal? This records a change, not proven improvement.")) return;
  if (action === "rollback" && !confirm("Restore the state before this lesson? Rollback refuses later edits.")) return;
  if (action === "verify") {
    if (!observation || !confirm("Have you checked this source and confirmed a successful, relevant later outcome?")) return;
    body = { observation };
  }
  busy.value = l.id;
  errorMsg.value = "";
  try { await post(`/v1/lessons/${l.id}/${action}`, body); await load(); }
  catch (e: any) { await load(); errorMsg.value = e.message; }
  finally { busy.value = null; }
}

async function scan() {
  busy.value = "scan";
  try { await post("/v1/lessons/scan"); await load(); }
  catch (e: any) { errorMsg.value = e.message; }
  finally { busy.value = null; }
}

const groups = computed(() => [
  { id: "review", title: "Needs your decision", hint: "Every proposed write waits for approval. Content checks do not prove behavior.", items: lessons.value.filter(l => l.status === "proposed") },
  { id: "blocked", title: "Blocked or interrupted", hint: "Inspect the target before reconciliation. No automatic retry writes.", items: lessons.value.filter(l => ["blocked", "applying"].includes(l.status)) },
  { id: "guard", title: "Needs a code check", hint: "The rule was available but ignored. More text is not a proven fix.", items: lessons.value.filter(l => l.needs_guard && ["candidate", "supported", "corroborated"].includes(l.status)) },
  { id: "watch", title: "Applied changes", hint: "Applied is not verified. Only relevant later evidence can support improvement.", items: lessons.value.filter(l => ["applied", "verified", "confirmed", "ineffective"].includes(l.status)) },
  { id: "evidence", title: "Collecting evidence", hint: "Original sources need review. Repeated copies do not add support.", items: lessons.value.filter(l => ["candidate", "supported", "corroborated"].includes(l.status) && !l.needs_guard) },
]);

/** Bounded linear diff: preserve shared prefix/suffix; replace the changed middle. */
function diff(a: string, b: string): { t: " " | "-" | "+"; s: string }[] {
  const x = a.split("\n"), y = b.split("\n");
  let start = 0, end = 0;
  while (start < Math.min(x.length,y.length) && x[start] === y[start]) start++;
  while (end < Math.min(x.length,y.length)-start && x[x.length-1-end] === y[y.length-1-end]) end++;
  return [
    ...x.slice(0,start).map(s => ({ t: " " as const, s })),
    ...x.slice(start,x.length-end).map(s => ({ t: "-" as const, s })),
    ...y.slice(start,y.length-end).map(s => ({ t: "+" as const, s })),
    ...x.slice(x.length-end).map(s => ({ t: " " as const, s })),
  ];
}
function before(l: Lesson) {
  if (l.scope !== "memory" || !l.current) return l.current ?? "";
  try { return JSON.parse(l.current).row.content; } catch { return l.current; }
}
const rollbackable = (l: Lesson) => ["applied", "verified", "ineffective", "blocked"].includes(l.status) && l.changes.at(-1)?.state === "applied" && l.currentMatches === true;
const canReconcile = (l: Lesson) => ["blocked", "applying"].includes(l.status) && ["applying", "reverting"].includes(l.changes.at(-1)?.state ?? "");
const canReject = (l: Lesson) => ["candidate", "supported", "corroborated", "proposed"].includes(l.status) || (l.status === "blocked" && l.changes.at(-1)?.state === "proposed");
const when = (ts: number | null) => (ts ? new Date(ts).toLocaleString() : "");
const CAUSES: Record<string, string> = { missing: "rule was missing", not_loaded: "skill was not loaded", ignored: "rule was ignored", wrong: "rule was wrong" };

onMounted(load);
</script>

<template>
  <div class="grid">
    <div class="row">
      <span class="muted grow">{{ unassigned }} signal{{ unassigned === 1 ? "" : "s" }} waiting for contextual review</span>
      <button :disabled="busy !== null" @click="scan">{{ busy === "scan" ? "Scanning…" : "Scan idle sessions" }}</button>
    </div>
    <p v-if="projectionStale" class="msg err">MEMORY.md is stale or manually edited. The runtime omits that projection until reviewed. Database facts remain available.</p>
    <p v-for="item in dueReview" :key="item.id" class="muted">Review due · #{{ item.id }}: {{ item.claim }}</p>
    <p v-if="loading" class="muted" role="status">Loading…</p>
    <p v-if="errorMsg" class="msg err" role="alert">{{ errorMsg }}</p>
    <p v-if="!loading && !lessons.length" class="muted">No lessons yet. Luna scans each conversation after it goes idle.</p>

    <section v-for="g in groups" v-show="g.items.length" :key="g.id" class="grid" :data-group="g.id">
      <div>
        <b>{{ g.title }}</b> <span class="muted">({{ g.items.length }})</span>
        <div dir="auto" v-if="g.hint" class="muted text-xs">{{ g.hint }}</div>
      </div>
      <div v-for="l in g.items" :key="l.id" class="card grid" :data-lesson="l.id">
        <div class="row">
          <span class="pill">{{ l.status === "confirmed" ? "legacy confirmation" : l.status }}</span>
          <b dir="auto" class="grow">{{ l.claim }}</b>
        </div>
        <div class="muted text-xs">
          {{ l.scope }}<template v-if="l.skill"> · {{ l.skill }}</template><template v-if="l.target"> · {{ l.target }}</template> · {{ l.domain }}
          <template v-if="l.cause"> · {{ CAUSES[l.cause] ?? l.cause }}</template>
          · {{ l.sessions }} session{{ l.sessions === 1 ? "" : "s" }}
          <template v-if="l.failures"> · failed {{ l.failures }}×</template>
        </div>

        <p v-if="l.note" class="muted text-xs">{{ l.note }}</p>
        <p v-if="l.currentMatches === false" class="msg err">The target changed after apply. Verification and rollback are blocked.</p>
        <p v-if="['applied', 'verified', 'confirmed', 'ineffective'].includes(l.status)" class="muted text-xs">{{ l.effect }}</p>
        <template v-if="l.status === 'proposed'">
          <div v-if="l.critical" class="text-xs" data-critical>Held because: {{ l.critical }}</div>
          <pre class="lesson-diff"><span v-for="(d, i) in diff(before(l), l.proposal ?? '')" :key="i" :class="{ add: d.t === '+', del: d.t === '-' }">{{ d.t }} {{ d.s }}
</span></pre>
          <div v-if="l.tests.length" class="muted text-xs">Content-only check (not behavioral proof): must contain {{ l.tests.map((t) => `"${t}"`).join(", ") }}</div>
        </template>

        <button class="link-button" @click="open[l.id] = !open[l.id]">{{ open[l.id] ? "Hide evidence" : `Evidence (${l.evidence.length})` }}</button>
        <ul v-if="open[l.id]" class="evidence">
          <li v-for="e in l.evidence" :key="e.id"><span class="muted">{{ e.kind }} · session {{ e.session }} · message {{ e.message }} · {{ when(e.ts) }}</span><br>{{ e.summary }}
            <div v-if="e.context" class="muted">Task message {{ e.context.task ?? 'unknown' }} · action message {{ e.context.action ?? 'unknown' }}</div>
            <div v-for="a in l.assessments.filter(a => a.signal === e.id)" :key="a.signal">{{ a.role }}: {{ a.rationale }}</div>
          </li>
        </ul>

        <div v-if="open[l.id]" class="grid">
          <div v-for="o in l.observations" :key="o.id" class="text-xs">
            <b>{{ o.outcome }}</b> · session {{ o.conv }} · message {{ o.entry }}
            <p>{{ o.relevance }}</p><p>{{ o.evidence }}</p>
            <button v-if="o.outcome === 'success' && ['applied', 'ineffective'].includes(l.status) && l.currentMatches === true" :disabled="busy !== null" @click="act(l, 'verify', o.id)">Verify this outcome</button>
          </div>
        </div>
        <div class="row" v-if="canReject(l) || rollbackable(l) || canReconcile(l)">
          <button v-if="l.status === 'proposed'" :disabled="busy !== null || !l.changes.length" @click="act(l, 'approve')">Approve</button>
          <button v-if="canReject(l)" :disabled="busy !== null" @click="act(l, 'reject')">Reject</button>
          <button v-if="rollbackable(l)" :disabled="busy !== null" @click="act(l, 'rollback')">Roll back</button>
          <button v-if="canReconcile(l)" :disabled="busy !== null" @click="act(l, 'reconcile')">Reconcile target state</button>
        </div>
      </div>
    </section>

    <section v-if="historyCount > 0" class="grid">
      <button class="link-button" @click="toggleShowHistory">
        {{ showHistory ? "Hide" : "Show" }} rejected and replaced ({{ historyCount }})
      </button>
      <div v-for="l in showHistory ? history : []" :key="l.id" class="card grid" :data-lesson="l.id">
        <div class="row"><span class="pill">{{ l.status === "confirmed" ? "legacy confirmation" : l.status }}</span><span dir="auto" class="grow">{{ l.claim }}</span></div>
        <div dir="auto" v-if="l.note" class="muted text-xs">{{ l.note }}</div>
        <button class="link-button" :disabled="loadingHistory[l.id]" @click="toggleHistoryEvidence(l)">
          {{ loadingHistory[l.id] ? "Loading…" : openHistory[l.id] ? "Hide evidence" : `Evidence (${l.evidenceCount ?? l.evidence?.length ?? 0})` }}
        </button>
        <ul v-if="openHistory[l.id]" class="evidence">
          <li v-for="e in l.evidence" :key="e.id"><span class="muted">{{ e.kind }} · session {{ e.session }} · message {{ e.message }} · {{ when(e.ts) }}</span><br>{{ e.summary }}
            <div v-if="e.context" class="muted">Task message {{ e.context.task ?? 'unknown' }} · action message {{ e.context.action ?? 'unknown' }}</div>
            <div v-for="a in (l.assessments || []).filter(a => a.signal === e.id)" :key="a.signal">{{ a.role }}: {{ a.rationale }}</div>
          </li>
        </ul>
      </div>
      <div v-if="showHistory && historyNextOffset !== null" class="row">
        <button class="link-button" :disabled="loadingMoreHistory" @click="loadHistoryPage(historyNextOffset)">
          {{ loadingMoreHistory ? "Loading more…" : "Load more" }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.lesson-diff { max-height: 320px; overflow: auto; font-size: 13.5px; font-weight: 450; white-space: pre-wrap; }
.lesson-diff span { display: block; }
.lesson-diff .add { color: var(--color-green-500, #3fb950); }
.lesson-diff .del { color: var(--color-red-500, #f85149); text-decoration: line-through; opacity: .8; }
.evidence { margin: 0; padding-left: 1rem; font-size: 13.5px; font-weight: 440; display: grid; gap: 6px; }
.link-button { justify-self: start; background: none; border: 0; padding: 0; color: var(--muted-foreground); text-decoration: underline; cursor: pointer; font-size: 13px; }
</style>
