<script setup lang="ts">
import { ref, computed } from "vue";
import ActivityPanel from "./ActivityPanel.vue";
import { chat, goalAction, answerQuestion } from "@/stores/chat";

const questions = computed(() => chat.extras?.questions || []);
const goal = computed(() => chat.extras?.goal || null);

const customAnswers = ref<Record<string, string>>({});
const notes = ref<Record<string, string>>({});

async function handleAnswer(q: any, cancelled = false) {
  if (cancelled) {
    await answerQuestion(q.callId, { cancelled: true });
    return;
  }
  const answers: any[] = [];
  q.questions.forEach((questionDef: any, qi: number) => {
    const name = `q${q.callId}-${qi}`;
    // Find checked inputs or custom text
    const custom = customAnswers.value[`${q.callId}-${qi}`] || "";
    // We can query DOM or collect via refs/inputs
    const container = document.querySelector(`[data-ask="${q.callId}"]`);
    if (!container) return;
    const checked = Array.from(container.querySelectorAll(`input[name="${name}"]:checked`)) as HTMLInputElement[];
    const picked = checked.map(el => el.value);
    if (questionDef.multiSelect) {
      if (picked.length || custom.trim()) {
        answers.push({ questionIndex: qi, kind: "multi", selected: picked, answer: custom.trim() || null });
      }
    } else {
      if (custom.trim()) {
        answers.push({ questionIndex: qi, kind: "custom", answer: custom.trim() });
      } else if (picked.length) {
        answers.push({ questionIndex: qi, kind: "option", answer: picked[0] });
      }
    }
  });
  const globalNote = notes.value[q.callId]?.trim();
  await answerQuestion(q.callId, { answers, ...(globalNote ? { globalNote } : {}) });
}
</script>

<template>
  <div id="extras">
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

    <!-- Questions -->
    <form v-for="q in questions" :key="q.callId" class="card grid" :data-ask="q.callId" @submit.prevent="handleAnswer(q)">
      <div v-for="(questionDef, qi) in q.questions" :key="qi" class="grid">
        <div class="row">
          <span class="pill">{{ questionDef.header }}</span>
          <b class="grow">{{ questionDef.question }}</b>
        </div>
        <label v-for="(opt, oi) in questionDef.options" :key="oi" class="opt">
          <input :type="questionDef.multiSelect ? 'checkbox' : 'radio'" :name="`q${q.callId}-${qi}`" :value="opt.label" />
          <span>
            <b>{{ opt.label }}</b>
            <div class="muted">{{ opt.description }}</div>
            <pre v-if="opt.preview" class="code">{{ opt.preview }}</pre>
          </span>
        </label>
        <input v-model="customAnswers[`${q.callId}-${qi}`]" placeholder="Or type your own answer" />
      </div>
      <input v-model="notes[q.callId]" placeholder="Note for Luna (optional)" />
      <div class="row">
        <button type="submit">Answer</button>
        <button type="button" @click="handleAnswer(q, true)">Decline</button>
      </div>
    </form>
  </div>
</template>
