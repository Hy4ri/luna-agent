<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { post } from "@/lib/api";
import { chat } from "@/stores/chat";
import { loadSessions } from "@/stores/sessions";

type PruneSession = { id: number; title: string | null; activity: number; ids: number[] };
const props = defineProps<{ project?: { id: number; name: string } | null }>();
const emit = defineEmits<{ close: []; deleted: [message: string] }>();
const days = ref<string | number>(7), includeArchived = ref(false), onlyProject = ref(!!props.project);
const sessions = ref<PruneSession[]>([]), kept = ref(new Set<number>());
const loading = ref(true), busy = ref(false), error = ref("");
const valid = computed(() => String(days.value).trim() !== "" && Number.isSafeInteger(Number(days.value))
  && Number(days.value) > 0 && Number.isSafeInteger(Number(days.value) * 86400000));
const chosen = computed(() => sessions.value.filter(s => !kept.value.has(s.id)));
// Confirm whole trees only. The server deletes nothing outside this list.
const confirmIds = computed(() => [...new Set(chosen.value.flatMap(s => s.ids))]);
const nested = computed(() => confirmIds.value.length - chosen.value.length);
const noun = (n: number) => n === 1 ? "session" : "sessions";
const age = (at: number) => {
  const h = Math.max(0, Math.floor((Date.now() - at) / 3600000));
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};
let generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
// Protect the selected conversation and every visible split tile. Read again at confirmation time.
function options() {
  const open = [chat.session, ...Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe[data-tile-session]"), frame => frame.dataset.tileSession)];
  return { days: Number(days.value), includeArchived: includeArchived.value,
    ...(onlyProject.value && props.project ? { projectId: props.project.id } : {}),
    excludeIds: [...new Set(open.map(Number).filter(n => Number.isSafeInteger(n) && n > 0))] };
}
async function preview() {
  const at = ++generation;
  clearTimeout(timer);
  error.value = "";
  if (!valid.value) { sessions.value = []; loading.value = false; return; }
  loading.value = true;
  try {
    const result = await post<{ ids: number[]; sessions: PruneSession[] }>("/v1/sessions/prune/preview", options());
    if (at === generation) sessions.value = result.sessions;
  } catch (e) { if (at === generation) { sessions.value = []; error.value = (e as Error).message; } }
  finally { if (at === generation) loading.value = false; }
}
// Typing in the days field waits for a pause. Checkbox changes preview at once.
watch(days, () => {
  generation++; loading.value = valid.value; clearTimeout(timer);
  timer = setTimeout(() => { void preview(); }, 300);
}, { flush: "sync" });
watch([includeArchived, onlyProject, () => chat.session], () => { void preview(); }, { immediate: true, flush: "sync" });
onUnmounted(() => { generation++; clearTimeout(timer); });
function toggle(id: number) {
  const next = new Set(kept.value);
  if (!next.delete(id)) next.add(id);
  kept.value = next;
}
function setAll(keep: boolean) { kept.value = keep ? new Set(sessions.value.map(s => s.id)) : new Set(); }
async function remove() {
  if (busy.value || loading.value || !valid.value || !confirmIds.value.length) return;
  busy.value = true; error.value = "";
  try {
    const result = await post<{ deleted: number[] }>("/v1/sessions/prune", { ...options(), ids: confirmIds.value });
    // Preserve the receipt even if a list refresh fails after the deletion succeeds.
    let receipt = `Deleted ${result.deleted.length} ${noun(result.deleted.length)}.`;
    try { await loadSessions(); } catch (e) { receipt += ` List refresh failed: ${(e as Error).message}`; }
    emit("deleted", receipt);
    emit("close");
  } catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}
function close() { if (!busy.value) emit("close"); }
</script>

<template>
  <Dialog :open="true" @update:open="value => { if (!value) close(); }">
    <DialogContent class="flex flex-col" style="width: min(36rem, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem - 2 * env(safe-area-inset-top)); overflow-y: auto" :show-close-button="false" @escape-key-down="event => { if (busy) event.preventDefault(); }" @interact-outside="event => { if (busy) event.preventDefault(); }">
      <DialogHeader>
        <DialogTitle>Prune sessions</DialogTitle>
        <DialogDescription>Delete sessions with no message activity for the selected number of days, across all projects, or only in the open project.</DialogDescription>
      </DialogHeader>
      <form class="flex flex-col gap-4 min-w-0 min-h-0 flex-1" @submit.prevent="remove">
        <div class="grid gap-2">
          <label for="prune-days" class="text-sm font-medium">Days</label>
          <Input id="prune-days" v-model="days" type="number" min="1" step="1" required :disabled="busy" aria-describedby="prune-days-error" />
          <p v-if="!valid" id="prune-days-error" class="text-sm text-destructive">Enter a positive whole number of days.</p>
        </div>
        <label class="flex items-center gap-2 text-sm">
          <input v-model="includeArchived" type="checkbox" :disabled="busy" class="accent-primary" />
          Include archived sessions
        </label>
        <label v-if="project" class="flex items-center gap-2 text-sm">
          <input v-model="onlyProject" type="checkbox" :disabled="busy" class="accent-primary" />
          Only in project “{{ project.name }}”
        </label>
        <p class="text-sm text-muted-foreground">Pinned sessions, open sessions, and sessions with running work are kept. Recent forks protect their parent sessions. Deletion is permanent and cannot be undone.</p>
        <div v-if="sessions.length" class="flex flex-col gap-1 min-w-0 min-h-24 flex-1" :class="{ 'opacity-60': loading }">
          <div class="flex items-center justify-between text-xs text-muted-foreground">
            <span>Clear a session to keep it.</span>
            <span class="flex gap-3">
              <button type="button" class="hover:text-foreground disabled:opacity-50" :disabled="busy || !kept.size" @click="setAll(false)">Select all</button>
              <button type="button" class="hover:text-foreground disabled:opacity-50" :disabled="busy || kept.size === sessions.length" @click="setAll(true)">Keep all</button>
            </span>
          </div>
          <ul class="min-h-0 flex-1 max-h-64 overflow-y-auto rounded-sm border border-border divide-y divide-border" aria-label="Sessions to delete">
            <li v-for="s in sessions" :key="s.id">
              <label class="flex items-center gap-2 px-2 py-1.5 text-sm cursor-pointer hover:bg-secondary min-w-0">
                <input type="checkbox" class="accent-primary shrink-0" :checked="!kept.has(s.id)" :disabled="busy" @change="toggle(s.id)" />
                <span class="truncate flex-1 min-w-0" :class="{ 'text-muted-foreground line-through': kept.has(s.id) }">{{ s.title || `Session ${s.id}` }}</span>
                <span v-if="s.ids.length > 1" class="shrink-0 text-xs text-muted-foreground" :title="`${s.ids.length - 1} fork or subagent ${noun(s.ids.length - 1)} deleted with it`">+{{ s.ids.length - 1 }}</span>
                <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ age(s.activity) }}</span>
              </label>
            </li>
          </ul>
        </div>
        <p role="status" class="text-sm" aria-live="polite">
          <template v-if="loading && !sessions.length">Checking sessions…</template>
          <template v-else-if="valid && !error">
            {{ chosen.length }} {{ noun(chosen.length) }}<template v-if="nested"> and {{ nested }} fork or subagent {{ noun(nested) }}</template> will be permanently deleted.
          </template>
        </p>
        <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
        <DialogFooter>
          <Button type="button" variant="outline" :disabled="busy" @click="close">Cancel</Button>
          <Button type="submit" variant="destructive" data-testid="prune-delete" :disabled="busy || loading || !valid || !confirmIds.length">
            {{ busy ? 'Deleting…' : `Delete ${confirmIds.length} ${noun(confirmIds.length)}` }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
