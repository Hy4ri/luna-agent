<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import ProjectIcon from "@/components/ProjectIcon.vue";
import { PROJECT_ICONS, isValidCustomIcon, type ProjectIcon as IconId } from "../../../src/project-appearance";
import { json, post } from "@/lib/api";
import type { Project } from "@/lib/types";
import { history } from "@/stores/sessions";

const props = defineProps<{ projectId: number }>();
const emit = defineEmits<{ close: [] }>();
const project = ref<Project | null>(null), loading = ref(true), busy = ref(false), error = ref("");
const icon = ref<string | null>(null), color = ref<string | null>(null);
const customDraft = ref("");
const isComposing = ref(false);

const labels: Record<IconId, string> = {
  folder: "Folder",
  code: "Code",
  terminal: "Terminal",
  globe: "Globe",
  smartphone: "Phone",
  layers: "Layers",
  database: "Database",
  "book-open": "Book",
  briefcase: "Briefcase",
  "flask-conical": "Science",
  rocket: "Rocket",
  wrench: "Tools"
};

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const customValidationError = computed(() => {
  if (isComposing.value) return "";
  const val = customDraft.value;
  if (!val) return "";
  const segments = Array.from(segmenter.segment(val));
  if (segments.length > 1) {
    return "Custom icon must be a single character or emoji";
  }
  if (!isValidCustomIcon(val)) {
    return "Invalid symbol or invisible character";
  }
  return "";
});

const hasCustomError = computed(() => !!customValidationError.value);

const dirty = computed(() => {
  if (!project.value) return false;
  const currentIcon = project.value.icon ?? null;
  const currentColor = project.value.color ?? null;
  return icon.value !== currentIcon || color.value !== currentColor;
});

let alive = true;
onUnmounted(() => { alive = false; });

function syncFromIcon(val: string | null) {
  if (val && !PROJECT_ICONS.includes(val as IconId)) {
    customDraft.value = val;
  } else {
    customDraft.value = "";
  }
}

function onCustomInput(event: Event) {
  const input = (event.target as HTMLInputElement).value;
  customDraft.value = input;
  if (isComposing.value) return;
  if (input === "") {
    if (icon.value && !PROJECT_ICONS.includes(icon.value as IconId)) {
      icon.value = null;
    }
  } else if (isValidCustomIcon(input)) {
    icon.value = input;
  }
}

function onCompositionStart() {
  isComposing.value = true;
}

function onCompositionEnd(event: CompositionEvent) {
  isComposing.value = false;
  const input = (event.target as HTMLInputElement).value;
  customDraft.value = input;
  if (input === "") {
    if (icon.value && !PROJECT_ICONS.includes(icon.value as IconId)) {
      icon.value = null;
    }
  } else if (isValidCustomIcon(input)) {
    icon.value = input;
  }
}

function selectIcon(id: IconId | null) {
  icon.value = id;
  customDraft.value = "";
}

// Mounted only while open: read server state on every open, not a stale sidebar snapshot.
onMounted(async () => {
  try {
    const result = await json<{ projects: Project[] }>("/v1/projects");
    if (!alive) return;
    const p = result.projects.find(p => p.id === props.projectId);
    if (!p) throw new Error("Project no longer exists");
    project.value = p;
    const initIcon = p.icon ?? null;
    icon.value = initIcon;
    color.value = p.color ?? null;
    syncFromIcon(initIcon);
  } catch (e) { if (alive) error.value = (e as Error).message; }
  finally { if (alive) loading.value = false; }
});

function close() { if (!busy.value) emit("close"); }

async function save() {
  if (loading.value || busy.value || isComposing.value || hasCustomError.value || !dirty.value) return;
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
    <DialogContent style="width: min(30rem, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem); overflow-y: auto" :show-close-button="false" @escape-key-down="event => { if (busy) event.preventDefault(); }" @interact-outside="event => { if (busy) event.preventDefault(); }">
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

          <div class="grid gap-2">
            <div class="flex items-center justify-between text-sm">
              <span class="font-medium">Icon</span>
              <Button type="button" variant="ghost" size="sm" class="h-7 px-2 text-xs" :disabled="icon === null && !customDraft" @click="selectIcon(null)">Use default</Button>
            </div>

            <!-- Icon Grid -->
            <div role="group" aria-label="Choose built-in icon" class="grid grid-cols-6 gap-2">
              <Tooltip v-for="id in PROJECT_ICONS" :key="id">
                <TooltipTrigger as-child>
                  <button
                    type="button"
                    :aria-pressed="icon === id"
                    :aria-label="labels[id]"
                    class="flex h-10 w-full items-center justify-center rounded-md border transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring"
                    :class="icon === id ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-input bg-background'"
                    @click="selectIcon(id)"
                  >
                    <ProjectIcon :icon="id" :size="18" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {{ labels[id] }}
                </TooltipContent>
              </Tooltip>
            </div>

            <!-- Custom symbol / emoji input -->
            <div class="mt-1 grid gap-1.5">
              <label for="custom-icon-input" class="text-xs text-muted-foreground">Or custom symbol or emoji (single character)</label>
              <div class="flex items-center gap-2">
                <input
                  id="custom-icon-input"
                  type="text"
                  :value="customDraft"
                  placeholder="e.g. π, 🚀, A"
                  aria-label="Custom symbol or emoji"
                  class="h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  :class="hasCustomError ? 'border-destructive focus-visible:outline-destructive' : 'border-input'"
                  @input="onCustomInput"
                  @compositionstart="onCompositionStart"
                  @compositionend="onCompositionEnd"
                />
                <Button
                  v-if="customDraft"
                  type="button"
                  variant="ghost"
                  size="sm"
                  class="h-9 px-2 text-xs"
                  @click="customDraft = ''; if (icon && !PROJECT_ICONS.includes(icon as IconId)) icon = null;"
                >
                  Clear
                </Button>
              </div>
              <p v-if="hasCustomError" role="alert" class="text-xs text-destructive">
                {{ customValidationError }}
              </p>
            </div>
          </div>

          <div class="grid gap-2 text-sm">
            <label for="project-color" class="font-medium">Icon color</label>
            <div class="flex items-center gap-3">
              <input id="project-color" type="color" :value="color || '#818cf8'" aria-label="Project icon color" class="h-10 w-14 cursor-pointer rounded-md border border-input bg-background p-1 focus-visible:outline-2 focus-visible:outline-ring" @input="color = ($event.target as HTMLInputElement).value" />
              <span class="text-muted-foreground">{{ color || 'Default (theme color)' }}</span>
              <Button type="button" variant="outline" class="ml-auto" :disabled="color === null" @click="color = null">Use default</Button>
            </div>
          </div>

          <Button type="button" variant="outline" class="justify-self-start" :disabled="icon === null && color === null && !customDraft" @click="selectIcon(null); color = null">Reset appearance</Button>
        </fieldset>
        <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
        <DialogFooter>
          <Button type="button" variant="outline" :disabled="busy" @click="close">Cancel</Button>
          <Button type="submit" :disabled="loading || busy || isComposing || hasCustomError || !dirty">{{ busy ? 'Saving…' : 'Save' }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
