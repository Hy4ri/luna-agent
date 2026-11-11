<script setup lang="ts">
import { computed } from "vue";
import ActivityPanel from "./ActivityPanel.vue";
import { chat, goalAction } from "@/stores/chat";

defineProps<{ docked?: boolean }>();
const goal = computed(() => chat.extras?.goal || null);
const taskCount = computed(() => goal.value?.tasks?.length || 0);
// Skipped tasks are resolved too, matching the existing goal counter.
const resolvedTasks = computed(() => goal.value?.tasks?.filter((t: { status: string }) => t.status !== 'pending').length || 0);
</script>

<template>
  <div :id="docked ? 'rail-extras' : 'extras'" class="chat-extras" :class="{ docked }">
    <!-- Goal Card -->
    <section v-if="goal" :key="`${chat.session}:${goal.id}`" class="card goal-card" aria-label="Session goal">
      <div class="goal-header">
        <b>Goal {{ goal.id }}</b>
        <span :class="['pill', goal.status === 'complete' ? 'ok' : goal.status === 'active' ? 'running' : '']">{{ goal.status.replaceAll('_', ' ') }}</span>
      </div>
      <p dir="auto" class="goal-objective">{{ goal.objective }}</p>
      <div class="goal-counters muted">
        <span v-if="taskCount">{{ resolvedTasks }} of {{ taskCount }} tasks</span>
        <span>{{ goal.runs }} / {{ goal.maxRuns }} runs</span>
      </div>
      <progress v-if="taskCount" class="goal-progress" :value="resolvedTasks" :max="taskCount" aria-label="Resolved goal tasks" />
      <div v-if="goal.tokenBudget" class="goal-budget muted">{{ goal.tokensUsed }} / {{ goal.tokenBudget }} tokens</div>
      <details class="goal-details">
        <summary>Objective details</summary>
        <p dir="auto">{{ goal.objective }}</p>
      </details>
      <p dir="auto" v-if="goal.statusReason" class="goal-reason muted">{{ goal.statusReason }}</p>
      <div class="goal-actions">
        <button v-if="goal.status === 'active'" @click="goalAction('pause')">Pause</button>
        <button v-else-if="goal.status !== 'complete'" @click="goalAction('resume')">Resume</button>
        <button class="goal-clear" @click="goalAction('clear')">Clear</button>
      </div>
    </section>

    <!-- Tasks, background processes, subagents -->
    <ActivityPanel :docked="docked" />
  </div>
</template>
