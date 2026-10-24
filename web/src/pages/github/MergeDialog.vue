<script setup lang="ts">
import { ref, watch } from "vue";
import type { RepoInfo, Detail } from "../../../../src/github";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const props = defineProps<{
  open: boolean;
  detail: Detail;
  info: RepoInfo;
  busy: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "confirm", method: "merge" | "squash" | "rebase", deleteBranch: boolean): void;
}>();

const selectedMethod = ref<"merge" | "squash" | "rebase">(
  props.info.merge.merge ? "merge" : props.info.merge.squash ? "squash" : "rebase"
);
const deleteBranchAfter = ref<boolean>(props.info.deleteBranchOnMerge);

watch(() => props.open, open => { if (open) { selectedMethod.value = props.info.merge.squash ? "squash" : props.info.merge.merge ? "merge" : "rebase"; deleteBranchAfter.value = props.info.deleteBranchOnMerge && !props.detail.pr?.crossRepo; } });
function handleConfirm() {
  if (props.busy || !props.info.merge[selectedMethod.value]) return;
  emit("confirm", selectedMethod.value, deleteBranchAfter.value);
}
</script>

<template>
  <Dialog :open="open" @update:open="(val) => emit('update:open', val)">
    <DialogContent class="max-w-md bg-card border border-border p-6 space-y-4">
      <DialogHeader class="space-y-1">
        <DialogTitle class="text-base font-semibold">Merge Pull Request #{{ detail.number }}</DialogTitle>
        <DialogDescription class="text-xs text-muted-foreground">
          Choose merge method and options. SHA verified at merge start.
        </DialogDescription>
      </DialogHeader>

      <div v-if="detail.pr" class="space-y-3 text-xs">
        <div class="flex items-center gap-2 font-mono bg-muted/50 p-2 rounded border border-border/40">
          <span class="text-primary truncate">{{ detail.pr.head }}</span>
          <span class="text-muted-foreground">→</span>
          <span class="text-primary truncate">{{ detail.pr.base }}</span>
        </div>

        <dl class="grid grid-cols-2 gap-1">
          <dt>Head commit</dt><dd class="font-mono">{{ detail.pr.headOid.slice(0, 12) }}</dd>
          <dt>Checks</dt><dd>{{ detail.pr.checkState ?? 'No checks' }}</dd>
          <dt>Reviews</dt><dd>{{ detail.pr.review ?? 'No review decision' }}</dd>
          <dt>Mergeability</dt><dd>{{ detail.pr.mergeable }} · {{ detail.pr.mergeState }}</dd>
        </dl>
        <div class="space-y-1.5">
          <label class="font-medium text-foreground">Merge method</label>
          <div class="grid grid-cols-3 gap-2">
            <button
              v-if="info.merge.merge"
              type="button"
              class="px-3 py-2 rounded border text-center transition-colors"
              :class="selectedMethod === 'merge' ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border hover:border-border/80 text-muted-foreground'"
              @click="selectedMethod = 'merge'"
            >
              Merge commit
            </button>
            <button
              v-if="info.merge.squash"
              type="button"
              class="px-3 py-2 rounded border text-center transition-colors"
              :class="selectedMethod === 'squash' ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border hover:border-border/80 text-muted-foreground'"
              @click="selectedMethod = 'squash'"
            >
              Squash & merge
            </button>
            <button
              v-if="info.merge.rebase"
              type="button"
              class="px-3 py-2 rounded border text-center transition-colors"
              :class="selectedMethod === 'rebase' ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border hover:border-border/80 text-muted-foreground'"
              @click="selectedMethod = 'rebase'"
            >
              Rebase & merge
            </button>
          </div>
        </div>

        <div v-if="detail.pr.headRepo && detail.pr.branchExists && !detail.pr.crossRepo && detail.pr.head !== info.defaultBranch" class="flex items-center gap-2 pt-1">
          <input
            id="delete-branch-checkbox"
            v-model="deleteBranchAfter"
            type="checkbox"
            class="rounded border-border text-primary focus:ring-primary h-4 w-4"
          />
          <label for="delete-branch-checkbox" class="text-muted-foreground cursor-pointer select-none">
            Delete head branch (<span class="font-mono text-foreground">{{ detail.pr.head }}</span>) after merge
          </label>
        </div>

        <div v-if="error" class="text-destructive font-medium bg-destructive/10 p-2 rounded">
          {{ error }}
        </div>
      </div>

      <DialogFooter class="flex items-center justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          :disabled="busy"
          @click="emit('update:open', false)"
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          :disabled="busy || !info.merge[selectedMethod]"
          @click="handleConfirm"
        >
          {{ busy ? 'Merging…' : `Merge #${detail.number} into ${detail.pr?.base}` }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
