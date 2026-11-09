<script setup lang="ts">
import { ref, watch } from "vue";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import MetaPicker from "./MetaPicker.vue";
import { createIssue, createPull } from "./client";
import type { RepoInfo } from "../../../../src/github";

const props = defineProps<{ open: boolean; repo: string; kind: "pr" | "issue"; info: RepoInfo | null }>();
const emit = defineEmits<{ "update:open": [boolean]; created: [number] }>();
const title = ref(""), body = ref(""), head = ref(""), base = ref(""), draft = ref(false);
const labels = ref<string[]>([]), assignees = ref<string[]>([]), busy = ref(false), error = ref("");
watch(() => props.open, open => {
  if (!open) return;
  title.value = body.value = head.value = error.value = ""; draft.value = false; labels.value = []; assignees.value = [];
  base.value = props.info?.defaultBranch ?? "";
});
async function submit() {
  if (busy.value || !title.value.trim()) return;
  busy.value = true; error.value = "";
  try {
    const t = title.value.trim(), b = body.value || undefined;
    const r = props.kind === "issue"
      ? await createIssue(props.repo, { title: t, body: b, ...(labels.value.length ? { labels: labels.value } : {}), ...(assignees.value.length ? { assignees: assignees.value } : {}) })
      : await createPull(props.repo, { title: t, head: head.value.trim(), base: base.value.trim(), body: b, draft: draft.value });
    emit("update:open", false); emit("created", r.number);
  } catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}
</script>

<template>
  <Dialog :open="open" @update:open="v => emit('update:open', v)">
    <DialogContent class="max-w-lg bg-card border border-border p-6 space-y-3">
      <DialogHeader class="space-y-1">
        <DialogTitle class="text-base font-semibold">{{ kind === 'issue' ? 'New issue' : 'New pull request' }}</DialogTitle>
        <DialogDescription class="text-xs text-muted-foreground">Creates it on GitHub in {{ repo }}.</DialogDescription>
      </DialogHeader>
      <input v-model="title" type="text" maxlength="256" placeholder="Title" aria-label="Title" class="w-full bg-background border border-border rounded px-3 py-2 text-sm focus:outline-none focus:border-primary" />
      <div v-if="kind === 'pr'" class="flex items-center gap-2 text-xs">
        <input v-model="head" type="text" placeholder="Head branch" aria-label="Head branch" class="min-w-0 flex-1 bg-background border border-border rounded px-2 py-1.5 font-mono focus:outline-none focus:border-primary" />
        <span class="text-muted-foreground">into</span>
        <input v-model="base" type="text" placeholder="Base branch" aria-label="Base branch" class="min-w-0 flex-1 bg-background border border-border rounded px-2 py-1.5 font-mono focus:outline-none focus:border-primary" />
      </div>
      <textarea v-model="body" rows="6" maxlength="65536" placeholder="Description (Markdown)" aria-label="Description" class="w-full bg-background border border-border rounded p-3 text-sm font-mono resize-y focus:outline-none focus:border-primary"></textarea>
      <label v-if="kind === 'pr'" class="flex items-center gap-2 text-xs"><input v-model="draft" type="checkbox" /> Open as draft</label>
      <MetaPicker v-else-if="open" v-model:labels="labels" v-model:assignees="assignees" :repo="repo" with-assignees />
      <p v-if="error" role="alert" class="text-xs text-destructive bg-destructive/10 p-2 rounded">{{ error }}</p>
      <DialogFooter class="flex justify-end gap-2 pt-2">
        <Button variant="ghost" size="sm" :disabled="busy" @click="emit('update:open', false)">Cancel</Button>
        <Button size="sm" :disabled="busy || !title.trim() || (kind === 'pr' && (!head.trim() || !base.trim()))" @click="submit">{{ busy ? 'Creating…' : 'Create' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
