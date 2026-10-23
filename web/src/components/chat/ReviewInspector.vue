<script setup lang="ts">
import { computed } from "vue";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { reviewJobs, type SideJob } from "@/stores/chat";
import SideJobCard from "./SideJobCard.vue";
import Markdown from "./Markdown.vue";

const props = defineProps<{ job: SideJob | null }>();
const emit = defineEmits<{ close: []; select: [id: string] }>();
const steps = computed(() => props.job?.activity || []);
const current = computed(() => steps.value.at(-1));
</script>

<template>
  <Dialog :open="!!job" @update:open="value => { if (!value) emit('close'); }">
    <DialogContent class="review-inspector">
      <DialogHeader>
        <DialogTitle>Review agent</DialogTitle>
        <DialogDescription>Read-only review · {{ job?.status }}</DialogDescription>
      </DialogHeader>
      <label v-if="reviewJobs.length > 1" class="grid gap-1 text-sm">Review
        <select :value="job?.id" class="w-full min-w-0 rounded border bg-background p-2" @change="emit('select', ($event.target as HTMLSelectElement).value)">
          <option v-for="review in reviewJobs" :key="review.id" :value="review.id">{{ new Date(review.createdAt).toLocaleTimeString() }} · {{ review.prompt }} · {{ review.status }}</option>
        </select>
      </label>
      <div v-if="job" class="review-scroll">
        <p v-if="job.status === 'running'" role="status" class="muted">{{ current?.text || 'Starting review…' }}</p>
        <details v-if="steps.length" class="review-steps" :open="job.status === 'running'">
          <summary>Activity · {{ steps.length }} events</summary>
          <ol>
            <li v-for="(step, index) in steps" :key="index">
              <Markdown v-if="step.kind === 'message'" :content="step.text" />
              <details v-else-if="step.kind === 'tool'">
                <summary :class="{ bad: step.isError }">{{ step.text }}</summary>
                <pre>{{ step.result }}</pre>
              </details>
              <span v-else class="muted">{{ step.text }}</span>
            </li>
          </ol>
        </details>
        <SideJobCard :key="job.id" :job="job" />
      </div>
    </DialogContent>
  </Dialog>
</template>

<style>
.review-inspector[data-slot="dialog-content"] { width: min(56rem, calc(100vw - 1rem)); max-width: min(56rem, calc(100vw - 1rem)); max-height: calc(100dvh - 1rem); display: flex; flex-direction: column; overflow: hidden; padding: 1rem; }
.review-scroll { min-height: 0; overflow-y: auto; overflow-x: hidden; overflow-wrap: anywhere; }
.review-scroll .side-job { margin: 1rem 0 0; max-width: 100%; }
.review-steps { margin-top: .75rem; font-size: .8125rem; }
.review-steps summary { cursor: pointer; overflow-wrap: anywhere; padding: .5rem 0; }
.review-steps ol { padding-left: 1.25rem; }
.review-steps li { padding: .25rem 0; }
.review-steps pre { max-height: 18rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: .75rem; }
</style>
