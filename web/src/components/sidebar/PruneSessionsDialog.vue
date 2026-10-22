<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { post } from "@/lib/api";
import { chat } from "@/stores/chat";
import { loadSessions } from "@/stores/sessions";

const emit = defineEmits<{ close: []; deleted: [message: string] }>();
const days = ref<string | number>(7), includeArchived = ref(false);
const ids = ref<number[]>([]), loading = ref(true), busy = ref(false), error = ref("");
const valid = computed(() => String(days.value).trim() !== "" && Number.isSafeInteger(Number(days.value))
  && Number(days.value) > 0 && Number.isSafeInteger(Number(days.value) * 86400000));
const noun = (n: number) => n === 1 ? "session" : "sessions";
let generation = 0;
// Protect the selected conversation and every visible split tile. Read again at confirmation time.
function options() {
  const open = [chat.session, ...Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe[data-tile-session]"), frame => frame.dataset.tileSession)];
  return { days: Number(days.value), includeArchived: includeArchived.value,
    excludeIds: [...new Set(open.map(Number).filter(n => Number.isSafeInteger(n) && n > 0))] };
}
async function preview() {
  const at = ++generation;
  ids.value = []; error.value = ""; loading.value = false;
  if (!valid.value) return;
  loading.value = true;
  try {
    const result = await post<{ ids: number[] }>("/v1/sessions/prune/preview", options());
    if (at === generation) ids.value = result.ids;
  } catch (e) { if (at === generation) error.value = (e as Error).message; }
  finally { if (at === generation) loading.value = false; }
}
watch([days, includeArchived, () => chat.session], () => { void preview(); }, { immediate: true, flush: "sync" });
onUnmounted(() => { generation++; });
async function remove() {
  if (busy.value || loading.value || !valid.value || !ids.value.length) return;
  busy.value = true; error.value = "";
  try {
    const result = await post<{ deleted: number[] }>("/v1/sessions/prune", { ...options(), ids: ids.value });
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
    <DialogContent style="width: min(32rem, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem - 2 * env(safe-area-inset-top)); overflow-y: auto" :show-close-button="false" @escape-key-down="event => { if (busy) event.preventDefault(); }" @interact-outside="event => { if (busy) event.preventDefault(); }">
      <DialogHeader>
        <DialogTitle>Prune sessions</DialogTitle>
        <DialogDescription>Delete sessions with no message activity for the selected number of days, across all projects.</DialogDescription>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="remove">
        <div class="grid gap-2">
          <label for="prune-days" class="text-sm font-medium">Days</label>
          <Input id="prune-days" v-model="days" type="number" min="1" step="1" required :disabled="busy" aria-describedby="prune-days-error" />
          <p v-if="!valid" id="prune-days-error" class="text-sm text-destructive">Enter a positive whole number of days.</p>
        </div>
        <label class="flex items-center gap-2 text-sm">
          <input v-model="includeArchived" type="checkbox" :disabled="busy" class="accent-primary" />
          Include archived sessions
        </label>
        <p class="text-sm text-muted-foreground">Open sessions and sessions with running work are kept. Recent forks protect their parent sessions. Deletion is permanent and cannot be undone.</p>
        <p role="status" class="text-sm" aria-live="polite">
          <template v-if="loading">Checking sessions…</template>
          <template v-else-if="valid && !error">{{ ids.length }} {{ noun(ids.length) }} will be permanently deleted.</template>
        </p>
        <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
        <DialogFooter>
          <Button type="button" variant="outline" :disabled="busy" @click="close">Cancel</Button>
          <Button type="submit" variant="destructive" data-testid="prune-delete" :disabled="busy || loading || !valid || !ids.length">
            {{ busy ? 'Deleting…' : `Delete ${ids.length} ${noun(ids.length)}` }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
