<script setup lang="ts">
import { ref, computed, nextTick, watch } from "vue";
import { chat, entryList, toolArgsText } from "@/stores/chat";
import Markdown from "./Markdown.vue";
import ToolCall from "./ToolCall.vue";
import SideContent from "./SideContent.vue";
import Welcome from "./Welcome.vue";

const logRef = ref<HTMLElement | null>(null);
const jumpRef = ref<HTMLElement | null>(null);

function scroll(force?: boolean) {
  const l = logRef.value;
  if (!l) return;
  if (force || l.scrollHeight - l.scrollTop - l.clientHeight < 200) {
    l.scrollTop = l.scrollHeight;
  }
}

function handleScroll() {
  const l = logRef.value;
  if (!l || !jumpRef.value) return;
  jumpRef.value.hidden = l.scrollHeight - l.scrollTop - l.clientHeight < 200;
}

function jumpClick() {
  scroll(true);
}

watch(() => chat.followTick, () => nextTick(() => scroll(true)));
watch(
  () => [chat.rev, chat.liveText, chat.sideJobs.size, chat.notices.length, chat.followTick],
  () => {
    nextTick(() => scroll());
  },
  { deep: true }
);

const results = computed(() => new Map(entryList.value.flatMap(e => (e.model || []).filter((m: any) => m.role === 'toolResult').map((m: any) => [m.toolCallId,m]))));
const calls = computed(() => new Set(entryList.value.flatMap(e => (e.model || []).flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((c: any) => c.type === 'toolCall').map((c: any) => c.id) : []))));
</script>

<template>
  <div id="log" ref="logRef" role="region" aria-label="Conversation" tabindex="0" @scroll="handleScroll">
    <Welcome v-if="!entryList.length && !chat.liveText && !chat.sideJobs.size" />

    <template v-for="e in entryList" :key="e.id">
      <div v-if="e.kind === 'pi.reset'" class="msg muted">— context reset —</div>
      <div v-else-if="e.kind === 'pi.compaction'" class="msg muted">— earlier messages compacted —</div>
      <template v-else-if="e.model && e.model.length">
        <template v-for="(m, mi) in e.model" :key="mi">
          <!-- User message -->
          <div v-if="m.role === 'user'" class="msg user" :data-entry="e.id">
            <template v-if="typeof m.content === 'string'">{{ m.content }}</template>
            <template v-else>
              <template v-for="(c, ci) in (m.content || [])" :key="ci">
                <span v-if="c.type === 'text'">{{ c.text }}</span>
                <img v-else-if="c.type === 'image'" class="att" :src="`data:${c.mimeType};base64,${c.data}`" alt="attachment" />
              </template>
            </template>
          </div>

          <!-- Assistant message -->
          <div v-else-if="m.role === 'assistant'" class="msg assistant">
            <Markdown :content="typeof m.content === 'string' ? m.content : (m.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')" />
            <template v-for="(c, ci) in (m.content || [])" :key="ci">
              <ToolCall v-if="c.type === 'toolCall'" :id="c.id" :name="c.name" :args="c.arguments" :result="results.get(c.id)" />
            </template>
            <div v-if="m.stopReason === 'error' && m.errorMessage" class="msg err">{{ m.errorMessage }}</div>
          </div>

          <!-- Tool result -->
          <ToolCall v-else-if="m.role === 'toolResult' && !calls.has(m.toolCallId)" :id="m.toolCallId" :name="m.toolName || 'tool'" :args="chat.toolStarts[m.toolCallId]?.args" :result="m" />
        </template>
      </template>
    </template>

    <template v-for="(tool,id) in chat.toolStarts" :key="id">
      <ToolCall v-if="!calls.has(id) && !results.has(id)" :id="id" :name="tool.name" :args="tool.args" />
    </template>
    <!-- Live message (streaming assistant partial) -->
    <div v-if="chat.liveText" class="msg assistant">
      <Markdown :content="chat.liveText" />
    </div>

    <!-- Notices -->
    <div v-for="notice in chat.notices" :key="notice.id" :class="['msg', notice.kind === 'err' ? 'err' : 'muted']">
      {{ notice.text }}
    </div>

    <!-- Side Jobs -->
    <section v-if="chat.sideJobs.size" class="side-jobs" aria-label="Side questions and background tasks">
      <div v-for="job in [...chat.sideJobs.values()].sort((a, b) => a.createdAt - b.createdAt)" :key="job.id" class="msg assistant side-job" :data-side-job="job.id">
        <p class="muted">/{{ job.kind }} · {{ job.status === 'running' ? 'Started' : job.status === 'complete' ? 'Complete' : 'Failed' }} · {{ job.id }} · Not in main history</p>
        <p>{{ job.prompt }}</p>
        <SideContent :job="job" />
      </div>
    </section>
  </div>

  <button id="jump" ref="jumpRef" hidden @click="jumpClick">Jump to bottom</button>
</template>
