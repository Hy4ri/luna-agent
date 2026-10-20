<script setup lang="ts">
import { computed } from "vue";
import ActivityPanel from "./ActivityPanel.vue";
import { chat, goalAction } from "@/stores/chat";

const goal = computed(() => chat.extras?.goal || null);
</script>

<template>
  <div id="extras" class="chat-extras">
    <!-- Goal Card -->
    <div v-if="goal" class="card grid">
      <div class="row">
        <b>Goal {{ goal.id }}</b>
        <span :class="['pill', goal.status === 'complete' ? 'ok' : goal.status === 'active' ? 'running' : '']">{{ goal.status }}</span>
        <span class="grow muted">runs {{ goal.runs }}/{{ goal.maxRuns }}{{ goal.tasks?.length ? ` · tasks ${goal.tasks.filter((t: any) => t.status !== 'pending').length}/${goal.tasks.length}` : '' }}{{ goal.tokenBudget ? ` · ${goal.tokensUsed}/${goal.tokenBudget} tok` : '' }}</span>
        <button v-if="goal.status !== 'complete' && goal.status === 'active'" @click="goalAction('pause')">Pause</button>
        <button v-if="goal.status !== 'complete' && goal.status !== 'active'" @click="goalAction('resume')">Resume</button>
        <button @click="goalAction('clear')">Clear</button>
      </div>
      <span class="muted">{{ goal.objective.length > 200 ? goal.objective.slice(0, 200) + '…' : goal.objective }}</span>
      <span v-if="goal.statusReason" class="muted">{{ goal.statusReason }}</span>
    </div>

    <!-- Tasks, background processes, subagents -->
    <ActivityPanel />
  </div>
</template>
