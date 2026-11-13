<template>
  <div id="steward-screen" class="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-background" :aria-busy="steward.loading ? 'true' : 'false'">
    <header class="shrink-0 flex items-center gap-3 flex-wrap px-6 py-3 max-[760px]:px-3 border-b border-border/60 bg-background">
      <Button id="steward-menu" type="button" variant="ghost" size="icon" class="hidden max-[760px]:inline-flex h-11 w-11 text-muted-foreground hover:text-foreground" aria-label="Open navigation" aria-controls="side" @click="setDrawer(true)">
        <Menu :size="18" />
      </Button>
      <div class="flex-1 min-w-0">
        <h1 tabindex="-1" class="m-0 text-lg font-semibold tracking-tight leading-tight">Steward</h1>
        <p class="m-0 text-xs text-muted-foreground truncate max-[760px]:hidden">Suggestions from your sessions. Nothing happens until you agree.</p>
      </div>
      <div class="flex items-center gap-2 ml-auto">
        <Button type="button" variant="outline" size="sm" class="max-[760px]:min-h-11" :disabled="steward.loading || steward.scanning" @click="scanSteward()">
          <RefreshCw :size="14" :class="{ 'animate-spin': steward.scanning }" aria-hidden="true" />
          {{ steward.scanning ? 'Scanning…' : 'Scan now' }}
        </Button>
        <button type="button" class="icon-button p-1.5 max-[760px]:min-h-11 max-[760px]:min-w-11 inline-flex items-center justify-center rounded-[var(--radius)] text-muted-foreground hover:text-foreground hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring" aria-label="Close steward" @click="navigate('chat')"><X :size="18" /></button>
      </div>
    </header>

    <div class="shrink-0 flex flex-wrap max-[760px]:flex-nowrap max-[760px]:overflow-x-auto max-[760px]:no-scrollbar gap-2 px-6 py-2 max-[760px]:px-3 border-b border-border/60" role="group" aria-label="Filter suggestions">
      <button v-for="f in statusChips" :key="f.id" type="button" class="chip" :class="{ on: status === f.id }" :aria-pressed="status === f.id" @click="status = f.id">{{ f.label }} <span class="tabular-nums opacity-70">{{ f.count }}</span></button>
      <span class="w-px bg-border mx-1" aria-hidden="true" />
      <button v-for="k in kindChips" :key="k.id" type="button" class="chip" :class="{ on: kind === k.id }" :aria-pressed="kind === k.id" @click="kind = kind === k.id ? '' : k.id">{{ k.label }} <span class="tabular-nums opacity-70">{{ k.count }}</span></button>
    </div>

    <section v-if="stats && stats.rules.length + stats.agree30.decisions > 0" class="shrink-0 px-6 py-2 max-[760px]:px-3 border-b border-border/60 text-xs text-muted-foreground">
      <details>
        <summary class="cursor-pointer py-1 max-[760px]:min-h-11 max-[760px]:flex max-[760px]:items-center focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 rounded-[var(--radius)]">
          <template v-if="stats.agree30.rate !== null">You agreed to {{ Math.round(stats.agree30.rate * 100) }}% of cards in the last 30 days ({{ stats.agree30.agrees }} of {{ stats.agree30.decisions }}).</template>
          <template v-else>No decisions in the last 30 days.</template>
        </summary>
        <table class="mt-2 w-full max-w-3xl text-left">
          <thead><tr><th class="font-medium pr-3">Rule</th><th class="font-medium pr-3">Decided</th><th class="font-medium pr-3">Agreed</th><th class="font-medium">Dismissed for</th></tr></thead>
          <tbody>
            <tr v-for="r in stats.rules" :key="r.ruleId">
              <td class="pr-3">{{ r.ruleId }}</td><td class="pr-3 tabular-nums">{{ r.decisions }}</td><td class="pr-3 tabular-nums">{{ r.agrees }}</td>
              <td>{{ Object.entries(r.reasons).map(([k, n]) => `${k} ${n}`).join(', ') || 'none' }}</td>
            </tr>
          </tbody>
        </table>
      </details>
    </section>

    <main class="flex-1 min-h-0 overflow-y-auto px-6 py-4 max-[760px]:px-3">
      <div v-if="steward.error" class="mb-3 flex flex-col sm:flex-row sm:items-center gap-3 rounded-[var(--radius)] border px-3.5 py-3 text-sm" :class="steward.error.toLowerCase().includes('disabled') ? 'border-border bg-card' : 'border-destructive/40'" :role="steward.error.toLowerCase().includes('disabled') ? 'status' : 'alert'">
        <div class="flex items-start gap-2.5 flex-1 min-w-0">
          <PauseCircle v-if="steward.error.toLowerCase().includes('disabled')" :size="18" class="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span class="flex-1 min-w-0 leading-snug">
            {{ steward.error.toLowerCase().includes('disabled') ? 'Steward is disabled — enable it in Settings → Automation to receive session suggestions.' : steward.error }}
          </span>
        </div>
        <div class="flex items-center gap-2 shrink-0 max-[760px]:justify-end">
          <Button v-if="steward.error.toLowerCase().includes('disabled')" type="button" variant="outline" size="sm" class="max-[760px]:min-h-11" @click="navigate('settings')">Open Settings</Button>
          <Button type="button" :variant="steward.error.toLowerCase().includes('disabled') ? 'ghost' : 'outline'" size="sm" class="max-[760px]:min-h-11" @click="loadSteward()">Retry</Button>
        </div>
      </div>
      <p v-if="steward.notice && !steward.error" class="mb-3 text-sm text-muted-foreground" role="status">{{ steward.notice }}</p>
      <p v-if="steward.loading && !steward.loaded" class="text-sm text-muted-foreground">Loading…</p>
      <div v-else-if="!shown.length && !steward.error" class="flex flex-col items-center justify-center gap-1.5 px-4 py-12 text-center">
        <Sparkles :size="20" class="text-muted-foreground/60" aria-hidden="true" />
        <p class="m-0 text-sm font-medium text-muted-foreground">Nothing to suggest.</p>
        <p class="m-0 text-xs text-muted-foreground">Run Scan now to check recent sessions for patterns.</p>
      </div>
      <ul class="grid gap-3 list-none p-0 m-0 max-w-3xl" aria-label="Suggestions">
        <li v-for="c in shown" :key="c.id" class="rounded-[var(--radius)] border border-border bg-card p-4">
          <div class="flex items-start gap-3">
            <component :is="icons[c.kind]" :size="18" class="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div class="min-w-0 flex-1">
              <h2 class="m-0 text-sm font-semibold break-words">{{ c.title }}</h2>
              <p class="mt-1 mb-0 text-sm text-muted-foreground break-words">{{ c.body }}</p>
              <ul v-if="c.evidence.length" class="mt-2 mb-0 p-0 list-none flex flex-wrap gap-2">
                <li v-for="e in c.evidence" :key="e.sessionId + e.note"><button type="button" class="inline-flex items-center min-h-6 px-2 py-0.5 rounded-[var(--radius)] border border-border bg-secondary/60 hover:bg-accent max-[760px]:min-h-11 max-[760px]:px-3 text-xs text-primary-text focus-visible:outline-2 focus-visible:outline-ring" @click="openSession(e.sessionId)">Session {{ e.sessionId }}: {{ e.note }}</button></li>
              </ul>
              <fieldset v-if="items(c).length && (c.status === 'open' || c.status === 'snoozed')" class="mt-2 mb-0 p-0 border-0 grid gap-1 max-h-56 overflow-y-auto">
                <legend class="sr-only">Sessions to include</legend>
                <label v-for="it in items(c)" :key="it.id" class="flex items-center gap-2 min-h-6 max-[760px]:min-h-11 text-sm min-w-0 cursor-pointer">
                  <input type="checkbox" class="w-4 h-4 shrink-0 accent-[var(--primary)] focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2" :checked="isPicked(c, it.id)" @change="pick(c, it.id)" />
                  <span class="truncate">{{ it.title }}</span>
                </label>
              </fieldset>
              <p v-if="c.status === 'done' || c.status === 'failed'" class="mt-2 mb-0 text-xs" :class="c.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'">{{ c.result }}</p>
              <p v-else-if="c.status === 'snoozed' && c.snoozeUntil" class="mt-2 mb-0 text-xs text-muted-foreground tabular-nums">Back on {{ new Date(c.snoozeUntil).toLocaleDateString() }}</p>
              <p v-if="errors[c.id]" class="mt-2 mb-0 text-xs text-destructive" role="alert">{{ errors[c.id] }}</p>
            </div>
          </div>
          <div v-if="c.status === 'working' && c.sessionId" class="mt-3 flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" class="max-[760px]:min-h-11" @click="openSession(c.sessionId)"><MessageSquare :size="14" aria-hidden="true" />Open the work session</Button>
            <span class="text-xs text-muted-foreground">{{ c.result }}</span>
          </div>
          <div v-if="c.status === 'done' && c.undoUntil && c.undoUntil > Date.now()" class="mt-3 flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" class="max-[760px]:min-h-11" :disabled="steward.busy.has(c.id)" @click="run(c, 'undo')"><Undo2 :size="14" aria-hidden="true" />Undo</Button>
            <span class="text-xs text-muted-foreground tabular-nums">until {{ new Date(c.undoUntil).toLocaleDateString() }}</span>
          </div>
          <div v-if="c.status === 'open' || c.status === 'snoozed'" class="mt-3 flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" class="max-[760px]:min-h-11" :disabled="steward.busy.has(c.id)" @click="agree(c)">{{ items(c).length ? `Agree (${picked(c).length})` : c.kind === 'delete_session' ? 'Delete…' : c.kind === 'worktree_orphan' ? 'Remove…' : 'Agree' }}</Button>
            <Button type="button" variant="outline" size="sm" class="max-[760px]:min-h-11" :disabled="steward.busy.has(c.id)" @click="discuss(c)"><MessageSquare :size="14" aria-hidden="true" />Discuss</Button>
            <DropdownMenu>
              <DropdownMenuTrigger as-child><Button type="button" variant="outline" size="sm" class="max-[760px]:min-h-11" :disabled="steward.busy.has(c.id)"><Clock :size="14" aria-hidden="true" />Snooze</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem v-for="d in [1, 7, 30]" :key="d" @select="run(c, 'snooze', { days: d })">{{ d }} {{ d === 1 ? 'day' : 'days' }}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger as-child><Button type="button" variant="ghost" size="sm" class="max-[760px]:min-h-11" :disabled="steward.busy.has(c.id)">Dismiss</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem v-for="r in reasons" :key="r.id" @select="dismiss(c, r.id)">{{ r.label }}</DropdownMenuItem>
                <DropdownMenuItem @select="dismiss(c)">Dismiss with a note…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </li>
      </ul>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { AlarmClock, Gauge, KanbanSquare, Target, Archive, BellOff, SlidersHorizontal, Clock, FolderPlus, FolderInput, Lightbulb, Menu, PauseCircle, RefreshCw, Sparkles, Trash2, Undo2, X, BookOpen, MessageSquare, GitBranch, Terminal, Wrench, Repeat } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { confirmAction, promptText } from "@/lib/confirm";
import { navigate, setDrawer } from "@/stores/app";
import { openSession } from "@/stores/chat";
import { decide, discussCard, loadSteward, scanSteward, steward, stewardStats, type Suggestion, type StewardKind, type StewardStatus } from "@/stores/steward";

const icons: Record<StewardKind, unknown> = { skill: Sparkles, memory: BookOpen, new_project: FolderPlus, move_session: FolderInput, archive_session: Archive, delete_session: Trash2, feature_tip: Lightbulb, tune_rule: SlidersHorizontal, mute_rule: BellOff, mute_kind: BellOff, goal_unfinished: Target, cron_failing: AlarmClock, quota_waits: Gauge, board_stuck: KanbanSquare, worktree_orphan: GitBranch, bg_leftover: Terminal, tool_error_repeat: Wrench, skill_unused: Archive, prompt_repeat: Repeat, project_setup_repeat: FolderPlus, new_rule: Sparkles, rule_idea: Sparkles, browser_leftover: Terminal, promote_rule: Sparkles, cost_habit: Gauge, compaction_heavy: Gauge, weekly_recap: KanbanSquare, reminder_unscheduled: AlarmClock };
const kindLabels: Record<StewardKind, string> = { skill: "Skills", memory: "Memory", new_project: "New project", move_session: "Move", archive_session: "Archive", delete_session: "Delete", feature_tip: "Tips", tune_rule: "Tuning", mute_rule: "Mute", mute_kind: "Mute", goal_unfinished: "Goals", cron_failing: "Cron", quota_waits: "Quota", board_stuck: "Board", worktree_orphan: "Worktrees", bg_leftover: "Terminals", tool_error_repeat: "Tool errors", skill_unused: "Skills", prompt_repeat: "Prompts", project_setup_repeat: "Setup", new_rule: "Rules", rule_idea: "Rules", browser_leftover: "Leftovers", promote_rule: "Rules", cost_habit: "Cost", compaction_heavy: "Context", weekly_recap: "Recap", reminder_unscheduled: "Reminders" };
const status = ref<StewardStatus>("open");
const kind = ref<StewardKind | "">("");
const stats = computed(() => stewardStats.value);
const errors = reactive<Record<number, string>>({});

const statusChips = computed(() => (["open", "working", "snoozed", "done", "dismissed", "failed"] as StewardStatus[]).map(id => ({ id, label: id[0]!.toUpperCase() + id.slice(1), count: steward.cards.filter(c => c.status === id).length })));
const kindChips = computed(() => (Object.keys(kindLabels) as StewardKind[]).map(id => ({ id, label: kindLabels[id], count: steward.cards.filter(c => c.status === status.value && c.kind === id).length })).filter(k => k.count > 0 || kind.value === k.id));
const shown = computed(() => steward.cards.filter(c => c.status === status.value && (!kind.value || c.kind === kind.value)));

async function run(c: Suggestion, action: "agree" | "dismiss" | "snooze" | "undo", body: object = {}) {
  errors[c.id] = await decide(c.id, action, body);
}
// A batch card lists its targets. They all start checked, and agree acts on the checked ones.
const unchecked = reactive<Record<number, number[]>>({});
const items = (c: Suggestion) => (Array.isArray(c.payload.items) ? c.payload.items : []) as { id: number; title: string }[];
const isPicked = (c: Suggestion, id: number) => !(unchecked[c.id] ?? []).includes(id);
const picked = (c: Suggestion) => items(c).filter(i => isPicked(c, i.id)).map(i => i.id);
function pick(c: Suggestion, id: number) { const u = unchecked[c.id] ?? []; unchecked[c.id] = u.includes(id) ? u.filter(x => x !== id) : [...u, id]; }
const reasons = [
  { id: "wrong", label: "Wrong suggestion" }, { id: "not_now", label: "Not now (30 days)" }, { id: "already_done", label: "Already done" },
  { id: "dont_care_kind", label: "I don't care about this kind" }, { id: "too_aggressive", label: "Too aggressive" },
];
async function dismiss(c: Suggestion, reason?: string) {
  let note: string | undefined;
  if (!reason) {
    const text = await promptText({ title: "Dismiss with a note", message: "Steward reads your note when looking for new cards.", confirmLabel: "Dismiss", input: { label: "Note", required: false } });
    if (text === null) return;
    note = text.trim() || undefined;
  }
  await run(c, "dismiss", { reason, note });
}
async function discuss(c: Suggestion) {
  const r = await discussCard(c.id);
  if (r.error) errors[c.id] = r.error; else { errors[c.id] = ""; await openSession(r.sessionId); }
}
async function agree(c: Suggestion) {
  if (c.kind === "delete_session" && !await confirmAction({ title: "Delete this session?", message: `"${c.title}" will be deleted for good. This cannot be undone.`, confirmLabel: "Delete", danger: true })) return;
  if (c.kind === "worktree_orphan" && !await confirmAction({ title: "Remove this worktree?", message: `The worktree and its branch "${c.payload.branch}" will be removed.`, confirmLabel: "Remove", danger: true })) return;
  await run(c, "agree", { confirm: c.kind === "delete_session" || c.kind === "worktree_orphan", ...(items(c).length ? { targets: picked(c) } : {}) });
}
onMounted(loadSteward);
</script>

<style scoped>
.chip { display: inline-flex; align-items: center; gap: 0.375rem; border: 1px solid var(--input); border-radius: var(--radius); padding: 0.25rem 0.625rem; font-size: 0.75rem; color: var(--muted-foreground); background: transparent; }
.chip:hover { color: var(--foreground); background: var(--secondary); }
.chip:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.chip.on { color: var(--foreground); background: var(--secondary); border-color: var(--muted-foreground); font-weight: 600; }
@media (max-width: 760px) {
  .chip { min-height: 44px; display: inline-flex; align-items: center; white-space: nowrap; }
}
</style>
