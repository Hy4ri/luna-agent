<script setup lang="ts">
import { ref, computed } from "vue";
import { chat, answerQuestion } from "@/stores/chat";
import Markdown from "./Markdown.vue";

const questions = computed(() => chat.extras?.questions || []);

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
  <div v-if="questions.length" id="questions" class="chat-extras grid">
    <form v-for="q in questions" :key="q.callId" class="card grid" :data-ask="q.callId" @submit.prevent="handleAnswer(q)">
      <div v-for="(questionDef, qi) in q.questions" :key="qi" class="grid">
        <div class="row">
          <span dir="auto" class="pill">{{ questionDef.header }}</span>
          <b dir="auto" class="grow">{{ questionDef.question }}</b>
        </div>
        <Markdown v-if="questionDef.context" dir="auto" class="muted ask-context" :content="questionDef.context" />
        <label v-for="(opt, oi) in questionDef.options" :key="oi" class="opt">
          <input :type="questionDef.multiSelect ? 'checkbox' : 'radio'" :name="`q${q.callId}-${qi}`" :value="opt.label" />
          <span>
            <b dir="auto">{{ opt.label }}</b>
            <div dir="auto" class="muted">{{ opt.description }}</div>
            <pre dir="auto" v-if="opt.preview" class="code">{{ opt.preview }}</pre>
          </span>
        </label>
        <input dir="auto" v-model="customAnswers[`${q.callId}-${qi}`]" placeholder="Or type your own answer" />
      </div>
      <input dir="auto" v-model="notes[q.callId]" placeholder="Note for Luna (optional)" />
      <div class="row">
        <button type="submit">Answer</button>
        <button type="button" @click="handleAnswer(q, true)">Decline</button>
      </div>
    </form>
  </div>
</template>
