<script setup lang="ts">
import { ref, computed } from "vue";
import type { Detail } from "../../../../src/github";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const props = defineProps<{
  open: boolean;
  detail: Detail;
  busy: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "confirm", confirmNumber: number): void;
}>();

const inputVal = ref("");
const numericInput = computed(() => {
  const parsed = Number(inputVal.value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
});

const canConfirm = computed(() => inputVal.value.trim() === String(props.detail.number));

function handleConfirm() {
  if (canConfirm.value && !props.busy && numericInput.value !== null) {
    emit("confirm", numericInput.value);
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="(val) => { inputVal = ''; emit('update:open', val); }">
    <DialogContent class="max-w-md bg-card border border-destructive/30 p-6 space-y-4">
      <DialogHeader class="space-y-1">
        <DialogTitle class="text-base font-semibold text-destructive">Delete Issue #{{ detail.number }}</DialogTitle>
        <DialogDescription class="text-xs text-muted-foreground">
          This action is permanent and cannot be undone. Type the issue number to confirm.
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-3 text-xs">
        <div class="bg-destructive/10 border border-destructive/20 rounded p-3 text-foreground space-y-1">
          <p class="font-medium">You are about to delete:</p>
          <p class="font-semibold text-destructive">#{{ detail.number }} — {{ detail.title }}</p>
        </div>

        <div class="space-y-1.5">
          <label for="confirm-issue-input" class="font-medium text-foreground">
            Type <span class="font-mono font-bold text-destructive">{{ detail.number }}</span> to confirm:
          </label>
          <input
            id="confirm-issue-input"
            v-model="inputVal"
            type="text"
            :placeholder="String(detail.number)"
            class="w-full bg-background border border-border rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:border-destructive font-mono"
            autocomplete="off"
            autofocus
          />
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
          variant="destructive"
          size="sm"
          :disabled="!canConfirm || busy"
          @click="handleConfirm"
        >
          {{ busy ? 'Deleting…' : 'Delete Permanently' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
