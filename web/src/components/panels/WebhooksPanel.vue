<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { Copy, KeyRound, Trash2, Send, History, RotateCcw } from "@lucide/vue";
import { confirmAction } from "@/lib/confirm";
import { json, post, url as apiUrl } from "@/lib/api";
import { history, loadProjects } from "@/stores/sessions";

type Target = { kind: "session" | "project" | "cron"; id: number };
interface Inbound { id: number; name: string; slug: string; path: string; verify: "hmac" | "token"; target: Target; template: string | null; events: string[]; enabled: boolean; lastAt: number | null; received: number }
interface InLog { id: number; at: number; event: string | null; outcome: string; sessionId: number | null; detail: string | null }
interface Sub { id: number; name: string; url: string; events: string[]; format: "json" | "ntfy" | "discord" | "slack"; enabled: boolean }
interface Delivery { id: number; event: string; status: "pending" | "ok" | "failed"; attempts: number; nextAt: number | null; responseStatus: number | null; error: string | null; createdAt: number }

const OUT_EVENTS = ["session.finished", "session.review_finished", "session.needs_input", "session.needs_approval", "session.failed", "session.limit_reached", "cron.run.ok", "cron.run.failed"];

const tab = ref<"inbound" | "outbound">("inbound");
const errorMsg = ref("");
const inbound = ref<Inbound[]>([]);
const subs = ref<Sub[]>([]);
const jobs = ref<{ id: number; name: string }[]>([]);
const secret = ref<{ title: string; value: string; url?: string } | null>(null);
const logFor = ref<{ kind: "in" | "out"; id: number; rows: (InLog | Delivery)[] } | null>(null);
const busy = ref(false);

const inForm = reactive({ name: "", kind: "project" as Target["kind"], id: 0, verify: "hmac" as "hmac" | "token", events: "", template: "" });
const outForm = reactive({ name: "", url: "", format: "json" as Sub["format"], events: [] as string[] });

const origin = computed(() => apiUrl("") || location.origin);
const hookUrl = (h: Inbound) => origin.value.replace(/\/$/, "") + h.path;
const list = (s: string) => s.split(",").map(x => x.trim()).filter(Boolean);
const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "never");

function targetLabel(t: Target) {
  if (t.kind === "session") return `Session #${t.id}`;
  if (t.kind === "cron") return `Cron: ${jobs.value.find(j => j.id === t.id)?.name ?? `job ${t.id}`}`;
  return `New session in ${t.id === 0 ? "General" : history.projects.find(p => p.id === t.id)?.name ?? `project ${t.id}`}`;
}

async function guard(fn: () => Promise<unknown>) {
  busy.value = true; errorMsg.value = "";
  try { await fn(); } catch (e: any) { if (e.message !== "unauthorized") errorMsg.value = e.message; }
  finally { busy.value = false; }
}
async function refresh() {
  await guard(async () => {
    const [i, o, cron] = await Promise.all([
      json<Inbound[]>("/v1/webhooks/inbound"), json<Sub[]>("/v1/webhooks/outbound"),
      json<{ jobs: { id: number; name: string }[] }>("/v1/cron?summary=1").catch(() => ({ jobs: [] })),
    ]);
    inbound.value = i; subs.value = o; jobs.value = cron.jobs ?? [];
  });
}

async function addInbound() {
  await guard(async () => {
    const r = await post<Inbound & { secret: string }>("/v1/webhooks/inbound", {
      name: inForm.name, target: { kind: inForm.kind, id: Number(inForm.id) }, verify: inForm.verify,
      events: list(inForm.events), template: inForm.template || null,
    });
    secret.value = { title: `Secret for "${r.name}"`, value: r.secret, url: hookUrl(r) };
    Object.assign(inForm, { name: "", events: "", template: "" });
    await refresh();
  });
}
async function addSub() {
  await guard(async () => {
    const r = await post<Sub & { secret: string }>("/v1/webhooks/outbound", { name: outForm.name, url: outForm.url, format: outForm.format, events: outForm.events });
    secret.value = { title: `Signing secret for "${r.name}"`, value: r.secret };
    Object.assign(outForm, { name: "", url: "", events: [] });
    await refresh();
  });
}
const base = (kind: "in" | "out") => (kind === "in" ? "/v1/webhooks/inbound" : "/v1/webhooks/outbound");
async function toggle(kind: "in" | "out", id: number, enabled: boolean) {
  await guard(async () => { await post(`${base(kind)}/${id}`, { enabled }, "PATCH"); await refresh(); });
}
async function showSecret(kind: "in" | "out", item: Inbound | Sub) {
  await guard(async () => {
    const r = await json<{ secret: string }>(`${base(kind)}/${item.id}/secret`);
    secret.value = { title: `Secret for "${item.name}"`, value: r.secret, ...(kind === "in" ? { url: hookUrl(item as Inbound) } : {}) };
  });
}
async function rotate(kind: "in" | "out", item: Inbound | Sub) {
  if (!(await confirmAction({ title: `Rotate the secret of "${item.name}"?`, message: "The old secret stops working at once. Update the sender or receiver.", confirmLabel: "Rotate", danger: true }))) return;
  await guard(async () => {
    const r = await post<{ secret: string }>(`${base(kind)}/${item.id}/rotate`);
    secret.value = { title: `New secret for "${item.name}"`, value: r.secret, ...(kind === "in" ? { url: hookUrl(item as Inbound) } : {}) };
  });
}
async function remove(kind: "in" | "out", item: Inbound | Sub) {
  if (!(await confirmAction({ title: `Delete "${item.name}"?`, message: kind === "in" ? "Its URL stops working and its log is deleted." : "Pending deliveries and the delivery log are deleted.", confirmLabel: "Delete", danger: true }))) return;
  await guard(async () => {
    await json(`${base(kind)}/${item.id}`, { method: "DELETE" });
    if (logFor.value?.kind === kind && logFor.value.id === item.id) logFor.value = null;
    await refresh();
  });
}
async function showLog(kind: "in" | "out", id: number) {
  if (logFor.value?.kind === kind && logFor.value.id === id) { logFor.value = null; return; }
  await guard(async () => {
    const rows = await json<(InLog | Delivery)[]>(kind === "in" ? `/v1/webhooks/inbound/${id}/log` : `/v1/webhooks/outbound/${id}/deliveries`);
    logFor.value = { kind, id, rows };
  });
}
async function test(s: Sub) {
  await guard(async () => {
    await post(`/v1/webhooks/outbound/${s.id}/test`);
    await new Promise(r => setTimeout(r, 1500));
    logFor.value = null;
    await showLog("out", s.id);
  });
}
async function redeliver(d: Delivery, subId: number) {
  await guard(async () => {
    await post(`/v1/webhooks/deliveries/${d.id}/redeliver`);
    await new Promise(r => setTimeout(r, 1500));
    logFor.value = null;
    await showLog("out", subId);
  });
}
async function copy(text: string) { try { await navigator.clipboard.writeText(text); } catch {} }

onMounted(() => { void refresh(); void loadProjects().catch(() => {}); });
</script>

<template>
  <div class="grid" id="webhooks-panel">
    <div class="row" role="tablist" aria-label="Webhook direction">
      <button type="button" role="tab" :aria-selected="tab === 'inbound'" :class="{ active: tab === 'inbound' }" @click="tab = 'inbound'">Inbound ({{ inbound.length }})</button>
      <button type="button" role="tab" :aria-selected="tab === 'outbound'" :class="{ active: tab === 'outbound' }" @click="tab = 'outbound'">Outbound ({{ subs.length }})</button>
    </div>
    <p v-if="errorMsg" class="msg err" role="alert">{{ errorMsg }}</p>

    <div v-if="secret" class="card grid" id="webhook-secret">
      <b>{{ secret.title }}</b>
      <template v-if="secret.url">
        <span class="muted text-xs">Payload URL. The sender must reach this address.</span>
        <pre class="select-all whitespace-pre-wrap break-all">{{ secret.url }}</pre>
      </template>
      <span class="muted text-xs">Secret</span>
      <pre class="select-all whitespace-pre-wrap break-all">{{ secret.value }}</pre>
      <div class="row">
        <button v-if="secret.url" type="button" @click="copy(secret.url)"><Copy :size="14" /> Copy URL</button>
        <button type="button" @click="copy(secret.value)"><Copy :size="14" /> Copy secret</button>
        <button type="button" @click="secret = null">Done</button>
      </div>
    </div>

    <template v-if="tab === 'inbound'">
      <p class="muted text-xs">Other services POST to a hook URL. Luna checks the hook secret, then sends the payload to a session, starts a new session in a project, or runs a cron job.</p>
      <ul class="grid gap-2" aria-label="Inbound webhooks">
        <li v-for="h in inbound" :key="h.id" class="card grid" :data-webhook="h.id">
          <div class="row">
            <div class="flex-1 min-w-0">
              <b>{{ h.name }}</b>
              <div class="muted text-xs">{{ targetLabel(h.target) }} · {{ h.verify === 'hmac' ? 'HMAC signature' : 'Token' }} · {{ h.events.length ? h.events.join(', ') : 'all events' }}</div>
              <div class="muted text-xs truncate">{{ hookUrl(h) }}</div>
              <div class="muted text-xs">Received {{ h.received }} · last {{ when(h.lastAt) }}</div>
            </div>
            <label class="row text-xs"><input type="checkbox" :checked="h.enabled" :disabled="busy" @change="toggle('in', h.id, ($event.target as HTMLInputElement).checked)" /> Enabled</label>
          </div>
          <div class="row">
            <button type="button" @click="copy(hookUrl(h))"><Copy :size="14" /> URL</button>
            <button type="button" @click="showSecret('in', h)"><KeyRound :size="14" /> Secret</button>
            <button type="button" @click="rotate('in', h)"><RotateCcw :size="14" /> Rotate</button>
            <button type="button" :aria-expanded="logFor?.kind === 'in' && logFor.id === h.id" @click="showLog('in', h.id)"><History :size="14" /> Log</button>
            <button type="button" class="icon-button" :aria-label="'Delete ' + h.name" title="Delete" @click="remove('in', h)"><Trash2 :size="16" /></button>
          </div>
          <ul v-if="logFor?.kind === 'in' && logFor.id === h.id" class="grid gap-1 text-xs" aria-label="Recent calls">
            <li v-if="!logFor.rows.length" class="muted">No calls yet.</li>
            <li v-for="r in (logFor.rows as InLog[])" :key="r.id" class="row">
              <span :class="['hook-outcome', r.outcome]">{{ r.outcome }}</span>
              <span class="muted">{{ when(r.at) }}</span>
              <span v-if="r.event">{{ r.event }}</span>
              <span v-if="r.sessionId" class="muted">session #{{ r.sessionId }}</span>
              <span v-if="r.detail" class="muted">{{ r.detail }}</span>
            </li>
          </ul>
        </li>
      </ul>

      <form class="card grid" @submit.prevent="addInbound">
        <b>Add an inbound webhook</b>
        <input v-model="inForm.name" placeholder="Name, e.g. GitHub PRs" aria-label="Webhook name" maxlength="60" required />
        <div class="row hook-form-row">
          <select v-model="inForm.kind" aria-label="Target">
            <option value="project">New session in a project</option>
            <option value="session">Existing session</option>
            <option value="cron">Run a cron job</option>
          </select>
          <select v-if="inForm.kind === 'project'" v-model.number="inForm.id" aria-label="Project">
            <option :value="0">General</option>
            <option v-for="p in history.projects" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <select v-else-if="inForm.kind === 'cron'" v-model.number="inForm.id" aria-label="Cron job">
            <option v-for="j in jobs" :key="j.id" :value="j.id">{{ j.name }}</option>
          </select>
          <input v-else v-model.number="inForm.id" type="number" min="1" placeholder="Session id" aria-label="Session id" />
          <select v-model="inForm.verify" aria-label="Verification">
            <option value="hmac">HMAC signature (GitHub style)</option>
            <option value="token">Token header</option>
          </select>
        </div>
        <input v-model="inForm.events" placeholder="Events (optional), e.g. pull_request.opened, issues" aria-label="Event filter" />
        <textarea v-model="inForm.template" rows="3" placeholder="Template (optional), e.g. PR {{body.number}}: {{body.pull_request.title}}" aria-label="Template" />
        <div class="row"><button type="submit" :disabled="busy || !inForm.name.trim()" :title="!inForm.name.trim() ? 'Enter a webhook name' : busy ? 'Saving…' : undefined">Create webhook</button></div>
      </form>
    </template>

    <template v-else>
      <p class="muted text-xs">Luna POSTs events to these URLs, signed with X-Luna-Signature. Failed deliveries retry for about 7 hours and survive a restart.</p>
      <ul class="grid gap-2" aria-label="Outbound webhooks">
        <li v-for="s in subs" :key="s.id" class="card grid" :data-subscription="s.id">
          <div class="row">
            <div class="flex-1 min-w-0">
              <b>{{ s.name }}</b>
              <div class="muted text-xs truncate">{{ s.format }} · {{ s.url }}</div>
              <div class="muted text-xs">{{ s.events.length ? s.events.join(', ') : 'all events' }}</div>
            </div>
            <label class="row text-xs"><input type="checkbox" :checked="s.enabled" :disabled="busy" @change="toggle('out', s.id, ($event.target as HTMLInputElement).checked)" /> Enabled</label>
          </div>
          <div class="row">
            <button type="button" :disabled="busy" @click="test(s)"><Send :size="14" /> Test</button>
            <button type="button" @click="showSecret('out', s)"><KeyRound :size="14" /> Secret</button>
            <button type="button" @click="rotate('out', s)"><RotateCcw :size="14" /> Rotate</button>
            <button type="button" :aria-expanded="logFor?.kind === 'out' && logFor.id === s.id" @click="showLog('out', s.id)"><History :size="14" /> Deliveries</button>
            <button type="button" class="icon-button" :aria-label="'Delete ' + s.name" title="Delete" @click="remove('out', s)"><Trash2 :size="16" /></button>
          </div>
          <ul v-if="logFor?.kind === 'out' && logFor.id === s.id" class="grid gap-1 text-xs" aria-label="Recent deliveries">
            <li v-if="!logFor.rows.length" class="muted">No deliveries yet.</li>
            <li v-for="d in (logFor.rows as Delivery[])" :key="d.id" class="row">
              <span :class="['hook-outcome', d.status]">{{ d.status }}</span>
              <span class="muted">{{ when(d.createdAt) }}</span>
              <span>{{ d.event }}</span>
              <span class="muted">{{ d.attempts }} attempt{{ d.attempts === 1 ? '' : 's' }}{{ d.responseStatus ? ` · HTTP ${d.responseStatus}` : '' }}</span>
              <span v-if="d.status === 'pending' && d.nextAt" class="muted">next {{ when(d.nextAt) }}</span>
              <span v-if="d.error" class="muted truncate">{{ d.error }}</span>
              <button v-if="d.status !== 'pending'" type="button" :disabled="busy" @click="redeliver(d, s.id)">Redeliver</button>
            </li>
          </ul>
        </li>
      </ul>

      <form class="card grid" @submit.prevent="addSub">
        <b>Add an outbound webhook</b>
        <input v-model="outForm.name" placeholder="Name, e.g. Phone (ntfy)" aria-label="Subscription name" maxlength="60" required />
        <div class="row">
          <input v-model="outForm.url" type="url" placeholder="https://…" aria-label="URL" required class="flex-1" />
          <select v-model="outForm.format" aria-label="Format">
            <option value="json">JSON</option><option value="ntfy">ntfy</option><option value="discord">Discord</option><option value="slack">Slack</option>
          </select>
        </div>
        <fieldset class="row text-xs" aria-label="Events">
          <span class="muted">Events (none selected = all):</span>
          <label v-for="e in OUT_EVENTS" :key="e" class="row"><input v-model="outForm.events" type="checkbox" :value="e" /> {{ e }}</label>
        </fieldset>
        <div class="row"><button type="submit" :disabled="busy || !outForm.name.trim() || !outForm.url.trim()" :title="(!outForm.name.trim() || !outForm.url.trim()) ? 'Enter a name and URL' : busy ? 'Saving…' : undefined">Create subscription</button></div>
      </form>
    </template>
  </div>
</template>

<style scoped>
[role="tab"].active { border-color: var(--primary-text); background: var(--acc-soft); color: var(--foreground); }
.hook-form-row { flex-wrap: wrap; }
.hook-form-row > * { min-width: 0; flex: 1 1 140px; }
.hook-outcome { font-weight: 600; }
.hook-outcome.delivered, .hook-outcome.ok { color: var(--ok); }
.hook-outcome.rejected, .hook-outcome.failed { color: var(--destructive); }
.hook-outcome.pending, .hook-outcome.ignored, .hook-outcome.duplicate { color: var(--muted-foreground); }
</style>
