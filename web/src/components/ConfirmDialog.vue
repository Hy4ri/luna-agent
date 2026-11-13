<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { pending, settle } from "@/lib/confirm";

const text = ref("");
const open = computed(() => pending.value !== null);
const blocked = computed(() => !!pending.value?.input?.required && !text.value.trim());
watch(pending, () => { text.value = ""; });

function accept() {
  if (blocked.value) return;
  settle(pending.value?.input ? text.value : true);
}
function dismiss() { settle(pending.value?.input ? null : false); }
</script>

<template>
  <Dialog :open="open" @update:open="(value: boolean) => { if (!value) dismiss(); }">
    <DialogContent class="max-w-md gap-4" :show-close-button="false" @keydown.enter.exact="(e: KeyboardEvent) => { if ((e.target as HTMLElement).tagName !== 'TEXTAREA') accept(); }">
      <DialogHeader class="gap-1.5">
        <DialogTitle :class="pending?.danger ? 'text-destructive' : ''">{{ pending?.title }}</DialogTitle>
        <DialogDescription v-if="pending?.message" class="whitespace-pre-line">{{ pending.message }}</DialogDescription>
      </DialogHeader>
      <label v-if="pending?.input" class="grid gap-1.5 text-sm">
        <span class="text-muted-foreground">{{ pending.input.label }}</span>
        <input v-model="text" :placeholder="pending.input.placeholder" autocomplete="off" autofocus
          class="h-9 w-full border border-input bg-background px-3 text-sm outline-none focus-visible:border-primary" />
      </label>
      <DialogFooter class="gap-2">
        <Button type="button" variant="outline" size="sm" class="min-h-11 sm:min-h-8" @click="dismiss">Cancel</Button>
        <Button type="button" :variant="pending?.danger ? 'destructive' : 'default'" size="sm" class="min-h-11 sm:min-h-8" :disabled="blocked" @click="accept">
          {{ pending?.confirmLabel ?? "Confirm" }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
