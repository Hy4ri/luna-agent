<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import ProjectIcon from "@/components/ProjectIcon.vue";
import { PROJECT_ICONS, type ProjectIcon as IconId } from "../../../src/project-appearance";
import { json, post } from "@/lib/api";
import type { Project } from "@/lib/types";
import { history } from "@/stores/sessions";

const props = defineProps<{ projectId: number }>();
const emit = defineEmits<{ close: [] }>();
const project = ref<Project | null>(null), loading = ref(true), busy = ref(false), error = ref("");
const icon = ref<IconId | null>(null), color = ref<string | null>(null);
const dirty = computed(() => !!project.value && (icon.value !== (project.value.icon ?? null) || color.value !== (project.value.color ?? null)));
const labels: Record<IconId, string> = { folder: "Folder", code: "Code", terminal: "Terminal", globe: "Globe", smartphone: "Phone", layers: "Layers", database: "Database", "book-open": "Book", briefcase: "Briefcase", "flask-conical": "Science", rocket: "Rocket", wrench: "Tools" };
let alive = true;
onUnmounted(() => { alive = false; });
// Mounted only while open: read server state on every open, not a stale sidebar snapshot.
onMounted(async () => {
  try {
    const result = await json<{ projects: Project[] }>("/v1/projects");
    if (!alive) return;
    const p = result.projects.find(p => p.id === props.projectId && !p.general);
    if (!p) throw new Error("Project no longer exists");
    project.value = p; icon.value = p.icon ?? null; color.value = p.color ?? null;
  } catch (e) { if (alive) error.value = (e as Error).message; }
  finally { if (alive) loading.value = false; }
});
function close() { if (!busy.value) emit("close"); }
async function save() {
  if (loading.value || busy.value || !dirty.value) return;
  busy.value = true; error.value = "";
  try {
    const saved = await post<Project>(`/v1/projects/${props.projectId}`, { icon: icon.value, color: color.value }, "PATCH");
    if (!alive) return;
    // Use the server receipt. Do not overwrite a concurrent favourite/name change with the opening snapshot.
    history.projects = history.projects.map(p => p.id === saved.id ? { ...p, icon: saved.icon, color: saved.color } : p);
    emit("close");
  } catch (e) { if (alive) error.value = (e as Error).message; }
  finally { if (alive) busy.value = false; }
}
</script>

<template>
  <Dialog :open="true" @update:open="value => { if (!value) close(); }">
    <DialogContent style="width: min(28rem, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem); overflow-y: auto" :show-close-button="false" @escape-key-down="event => { if (busy) event.preventDefault(); }" @interact-outside="event => { if (busy) event.preventDefault(); }">
      <DialogHeader>
        <DialogTitle>Project appearance</DialogTitle>
        <DialogDescription>Choose a project icon and color. Changes are saved across devices.</DialogDescription>
      </DialogHeader>
      <p v-if="loading" role="status" class="text-sm text-muted-foreground">Loading…</p>
      <form class="grid gap-4" @submit.prevent="save">
        <fieldset v-if="project" :disabled="busy" class="grid min-w-0 gap-4">
          <div class="flex min-w-0 items-center gap-3 rounded-md border p-3" aria-label="Preview">
            <ProjectIcon :icon="icon" :color="color" :size="20" />
            <span dir="auto" class="truncate">{{ project.name }}</span>
          </div>
          <label class="grid gap-2 text-sm">Icon
            <select v-model="icon" aria-label="Project icon" class="h-11 w-full rounded-md border border-input bg-background px-3 text-foreground focus-visible:outline-2 focus-visible:outline-ring">
              <option :value="null">Default</option>
              <option v-for="id in PROJECT_ICONS" :key="id" :value="id">{{ labels[id] }}</option>
            </select>
          </label>
          <div class="grid gap-2 text-sm">
            <label for="project-color">Icon color</label>
            <div class="flex items-center gap-3">
              <input id="project-color" type="color" :value="color || '#818cf8'" aria-label="Project icon color" class="h-11 w-14 cursor-pointer rounded-md border border-input bg-background p-1 focus-visible:outline-2 focus-visible:outline-ring" @input="color = ($event.target as HTMLInputElement).value" />
              <span class="text-muted-foreground">{{ color || 'Default (theme color)' }}</span>
              <Button type="button" variant="outline" class="ml-auto" :disabled="color === null" @click="color = null">Use default</Button>
            </div>
          </div>
          <Button type="button" variant="outline" class="justify-self-start" :disabled="icon === null && color === null" @click="icon = null; color = null">Reset appearance</Button>
        </fieldset>
        <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
        <DialogFooter>
          <Button type="button" variant="outline" :disabled="busy" @click="close">Cancel</Button>
          <Button type="submit" :disabled="loading || busy || !dirty">{{ busy ? 'Saving…' : 'Save' }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
