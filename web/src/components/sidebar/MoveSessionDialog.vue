<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Check, LoaderCircle } from "@lucide/vue";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import ProjectIcon from "@/components/ProjectIcon.vue";
import { history, loadProjects, moveSession, sessionTitle } from "@/stores/sessions";
import type { SessionMeta } from "@/lib/types";

const props = defineProps<{ session: SessionMeta }>();
const emit = defineEmits<{ close: [] }>();
const query = ref(""), loading = ref(true), busy = ref(false), error = ref("");
const movingTo = ref<number | null>(null);
const projects = computed(() => history.projects.filter(p => p.name.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
async function refresh() {
  loading.value = true; error.value = "";
  try { await loadProjects({ force: true }); error.value = history.projectsError; }
  catch (e) { error.value = (e as Error).message; }
  finally { loading.value = false; }
}
onMounted(refresh);
function close() { if (!busy.value) emit("close"); }
async function move(project: number) {
  if (busy.value || loading.value || Number(props.session.project) === project) return;
  busy.value = true; movingTo.value = project; error.value = "";
  try {
    if (await moveSession(props.session, project)) emit("close");
    else error.value = history.status || "Could not move this session. Try again.";
  } catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; movingTo.value = null; }
}
</script>

<template>
  <Dialog :open="true" @update:open="value => { if (!value) close(); }">
    <DialogContent class="flex flex-col gap-3 p-4" style="width: min(28rem, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem - env(safe-area-inset-top) - env(safe-area-inset-bottom))" :show-close-button="false"
      @open-auto-focus="event => { event.preventDefault(); }"
      @escape-key-down="event => { if (busy) event.preventDefault(); }"
      @interact-outside="event => { if (busy) event.preventDefault(); }">
      <DialogHeader class="shrink-0 text-left">
        <DialogTitle>Move to project</DialogTitle>
        <DialogDescription class="truncate" :title="sessionTitle(session)">{{ sessionTitle(session) }}</DialogDescription>
      </DialogHeader>
      <Input v-model="query" type="search" placeholder="Search projects…" aria-label="Search projects" class="min-h-11 shrink-0" :disabled="busy" />
      <p v-if="error" role="alert" class="text-sm text-destructive shrink-0">{{ error }}</p>
      <div v-if="loading" role="status" class="py-4 text-sm text-muted-foreground">Loading projects…</div>
      <div v-else-if="history.projectsError" class="py-2"><Button variant="outline" class="min-h-11" @click="refresh">Retry</Button></div>
      <div v-else class="min-h-0 overflow-y-auto overscroll-contain flex flex-col gap-2" aria-label="Projects" :aria-busy="busy">
        <button v-for="p in projects" :key="p.id" type="button"
          class="flex min-h-12 shrink-0 items-center gap-3 rounded-xs border px-3 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="busy || Number(session.project) === p.id" @click="move(p.id)">
          <ProjectIcon :project="p" :size="20" class="shrink-0" />
          <span class="min-w-0 flex-1 break-words">{{ p.name }}</span>
          <LoaderCircle v-if="movingTo === p.id" :size="16" class="shrink-0 animate-spin" aria-label="Moving" />
          <template v-else-if="Number(session.project) === p.id"><span class="text-xs text-muted-foreground">Current</span><Check :size="16" class="shrink-0" /></template>
        </button>
        <p v-if="!projects.length" role="status" class="py-4 text-sm text-muted-foreground">No projects found.</p>
      </div>
      <Button variant="outline" class="min-h-11 shrink-0 self-end" :disabled="busy" @click="close">Cancel</Button>
    </DialogContent>
  </Dialog>
</template>
