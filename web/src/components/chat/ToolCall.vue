<script setup lang="ts">
import { computed, ref } from 'vue';
import { Check, CircleAlert, LoaderCircle, ChevronRight, Circle, CircleDot } from '@lucide/vue';
import { chat, openSession, toolArgsText } from '@/stores/chat';
import { formatTime, formatDateIso } from '@/lib/message';
import { toolView, toolSummary, parseEditDiff, argsEditDiff, diffCounts, splitHarness, diagnosticLines, parseJson, searchHits } from '@/lib/tool-view';
import Markdown from './Markdown.vue';
import DiffView from './tool/DiffView.vue';
import CodeView from './tool/CodeView.vue';
import TerminalView from './tool/TerminalView.vue';
const props = defineProps<{ id: string; name: string; args?: unknown; result?: any; timestamp?: number | string }>();
const expanded = ref(false);
const result = computed(() => props.result ?? chat.toolResults[props.id]);
const state = computed(() => result.value ? result.value.isError === true ? 'failed' : 'complete' : chat.activeTools.has(props.id) ? 'running' : 'pending');
const output = computed(() => {
  if (!result.value) return chat.toolLive[props.id] || '';
  const content = result.value.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
  return content !== undefined ? JSON.stringify(content, null, 2) : '';
});
const argumentsText = computed(() => props.args === undefined ? '' : JSON.stringify(props.args, null, 2));
const images = computed(() => (Array.isArray(result.value?.content) ? result.value.content : []).filter((b: any) => b.type === 'image' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(b.mimeType) && typeof b.data === 'string'));
const child = computed(() => /spawned child (\d+)/.exec(output.value)?.[1]);
const timestamp = computed(() => result.value?.timestamp ?? chat.toolStarts[props.id]?.timestamp ?? props.timestamp);
const fullDate = computed(() => formatDateIso(timestamp.value) ? new Date(timestamp.value).toLocaleString() : '');

const view = computed(() => toolView(props.name));
const a = computed(() => (props.args && typeof props.args === 'object' ? props.args : {}) as Record<string, any>);
const summary = computed(() => toolSummary(props.name, props.args));
const details = computed(() => { const d = result.value?.details; return typeof d === 'string' ? parseJson(d) : d; });
// Text output without the runtime's `<harness>` diagnostics block; its lines show as notes. While running, the live
// stream starts with the arguments, which the specific views already show.
const split = computed(() => {
  if (result.value) return splitHarness(output.value);
  const prefix = toolArgsText(props.args);
  return { output: output.value.startsWith(prefix) ? output.value.slice(prefix.length) : output.value, diagnostics: '' } as ReturnType<typeof splitHarness>;
});
const body = computed(() => split.value.output);
const notes = computed(() => diagnosticLines(split.value.diagnostics));
const json = computed(() => parseJson(body.value));

// edit: the tool's own diff (real line numbers) when it finished; otherwise the requested old/new text.
const editApplied = computed(() => state.value === 'complete' && typeof details.value?.diff === 'string');
const diffRows = computed(() => view.value !== 'edit' ? [] : editApplied.value ? parseEditDiff(details.value.diff) : argsEditDiff(props.args));
const counts = computed(() => diffCounts(diffRows.value));
const writeLines = computed(() => view.value === 'write' && typeof a.value.content === 'string' ? a.value.content.replace(/\n$/, '').split('\n').length : 0);
const exitCode = computed(() => {
  if (view.value === 'bash') return split.value.exit;
  if (view.value === 'process' && typeof json.value?.exitCode === 'number') return json.value.exitCode;
  return undefined;
});
const proc = computed(() => view.value === 'process' && json.value && typeof json.value.command === 'string' ? json.value : undefined);
const tasks = computed(() => view.value === 'todo' && Array.isArray(details.value?.tasks) ? details.value.tasks.filter((t: any) => t.status !== 'deleted') : []);
const hits = computed(() => view.value === 'web_search' ? searchHits(body.value) : []);
const page = computed(() => view.value === 'web_extract' && typeof json.value?.url === 'string' ? json.value : undefined);
const answers = computed(() => view.value === 'answers' && Array.isArray(details.value?.answers) ? details.value.answers : []);
const media = computed(() => {
  if (view.value !== 'media' || !json.value || typeof json.value !== 'object') return '';
  const j = json.value;
  if (props.name === 'vision_analyze') return typeof j.width === 'number' ? `${j.width}×${j.height}` : '';
  return [j.model, j.image].filter((x: unknown) => typeof x === 'string' && x).join(' · ');
});
const hasBody = computed(() => {
  if (state.value === 'failed') return view.value === 'edit';
  switch (view.value) {
    case 'edit': return diffRows.value.length > 0;
    case 'write': return writeLines.value > 0;
    case 'process': return !!proc.value?.output || (!proc.value && !!body.value);
    case 'todo': return tasks.value.length > 0 || !!body.value;
    case 'media': return !!media.value;
    case 'skill': return props.name === 'skill_propose' ? typeof a.value.content === 'string' : !!body.value;
    default: return !!body.value;
  }
});
</script>
<template>
  <div class="tool" :data-call="id" :data-state="state" :data-tool="view !== 'generic' ? name : undefined">
    <details :open="expanded" @toggle="expanded = ($event.target as HTMLDetailsElement).open">
      <summary>
        <CircleAlert v-if="state === 'failed'" :size="14" class="tool-status-icon" aria-hidden="true" />
        <Check v-else-if="state === 'complete'" :size="14" aria-hidden="true" />
        <LoaderCircle v-else :size="14" aria-hidden="true" />
        <span class="tool-name">{{ name }}</span>
        <span v-if="summary" class="tool-summary" :title="summary">{{ view === 'bash' ? '$ ' + summary : summary }}</span>
        <span v-if="editApplied && (counts.add || counts.del)" class="tool-counts"><span class="diff-add-count">+{{ counts.add }}</span> <span class="diff-del-count">−{{ counts.del }}</span></span>
        <span v-if="writeLines && state === 'complete'" class="tool-counts">{{ writeLines }} line{{ writeLines === 1 ? '' : 's' }}</span>
        <span v-if="proc && proc.running" class="tool-counts">running</span>
        <span v-if="exitCode !== undefined && exitCode !== null && exitCode !== 0" class="tool-exit">exit {{ exitCode }}</span>
        <span class="tool-state">{{ state === 'failed' ? 'Failed' : state === 'complete' ? 'Complete' : state === 'running' ? 'Running' : 'No result' }}</span>
        <a v-if="child" href="#" @click.prevent.stop="openSession(child)">Child {{ child }}</a>
        <ChevronRight :size="13" class="disclosure-chevron" aria-hidden="true" />
      </summary>
      <template v-if="view === 'generic'">
        <div v-if="argumentsText" class="tool-section"><span class="tool-section-label">Arguments</span><pre>{{ argumentsText }}</pre></div>
        <div v-if="state !== 'failed' && output" class="tool-section"><span class="tool-section-label">Output</span><pre>{{ output }}</pre></div>
      </template>
      <template v-else>
        <div v-if="hasBody" class="tool-section" :data-view="view">
          <template v-if="view === 'edit'">
            <span class="tool-section-label">{{ editApplied ? 'Diff' : 'Requested change (not applied, no line numbers)' }}</span>
            <DiffView :rows="diffRows" :label="'Changes to ' + summary" />
          </template>
          <TerminalView v-else-if="view === 'bash'" :text="body" />
          <CodeView v-else-if="view === 'write'" :text="a.content" />
          <CodeView v-else-if="view === 'read'" :text="body" :start="typeof a.offset === 'number' ? a.offset : 1" />
          <template v-else-if="view === 'process'">
            <template v-if="proc">
              <span class="tool-section-label">{{ proc.status }}{{ proc.truncated ? ' · output truncated' : '' }}</span>
              <TerminalView :text="proc.output" />
            </template>
            <pre v-else>{{ body }}</pre>
          </template>
          <template v-else-if="view === 'todo'">
            <p v-if="body" class="tool-line" dir="auto">{{ body }}</p>
            <ul v-if="tasks.length" class="tool-tasks">
              <li v-for="t in tasks" :key="t.id" :data-status="t.status">
                <Check v-if="t.status === 'completed'" :size="13" aria-hidden="true" />
                <CircleDot v-else-if="t.status === 'in_progress'" :size="13" aria-hidden="true" />
                <Circle v-else :size="13" aria-hidden="true" />
                <span class="tool-task-id">#{{ t.id }}</span>
                <span dir="auto">{{ t.status === 'in_progress' && t.activeForm ? t.activeForm : t.subject }}</span>
              </li>
            </ul>
          </template>
          <ul v-else-if="view === 'web_search' && hits.length" class="tool-hits">
            <li v-for="(h, i) in hits" :key="i"><a :href="h.url" target="_blank" rel="noopener noreferrer" dir="auto">{{ h.title }}</a><span class="tool-host">{{ h.host }}</span><p v-if="h.snippet" dir="auto">{{ h.snippet }}</p></li>
          </ul>
          <template v-else-if="view === 'web_extract' && page">
            <a class="tool-line tool-link" :href="page.url" target="_blank" rel="noopener noreferrer">{{ page.url }}</a>
            <pre class="tool-prose" dir="auto">{{ page.content }}</pre>
          </template>
          <dl v-else-if="view === 'answers' && answers.length" class="tool-answers">
            <template v-for="(q, i) in answers" :key="i"><dt dir="auto">{{ q.question }}</dt><dd dir="auto">{{ q.answer }}</dd></template>
          </dl>
          <template v-else-if="view === 'skill'">
            <template v-if="name === 'skill_propose'">
              <span class="tool-section-label">Proposed content</span>
              <CodeView :text="a.content" />
              <pre v-if="body">{{ body }}</pre>
            </template>
            <Markdown v-else class="tool-md" :content="body" />
          </template>
          <p v-else-if="view === 'media'" class="tool-line">{{ media }}</p>
          <pre v-else>{{ body }}</pre>
        </div>
        <ul v-if="notes.length && state !== 'failed' && view !== 'bash'" class="tool-notes"><li v-for="(n, i) in notes" :key="i">{{ n }}</li></ul>
        <details v-if="argumentsText" class="tool-raw"><summary>Raw arguments</summary><pre>{{ argumentsText }}</pre></details>
      </template>
      <img v-for="(image, i) in images" :key="i" class="tool-image" :src="`data:${image.mimeType};base64,${image.data}`" :alt="name + ' result'" />
    </details>
    <div v-if="state === 'failed' && view === 'bash' && split.exit !== undefined" class="tool-error"><span class="tool-section-label">Exited with code {{ split.exit }}</span><TerminalView :text="body" /></div>
    <div v-else-if="state === 'failed'" class="tool-error"><span class="tool-section-label">Error</span><pre>{{ output || 'The tool failed without error details.' }}</pre></div>
    <div v-if="formatTime(timestamp)" class="tool-footer"><time :datetime="formatDateIso(timestamp)" :title="fullDate">{{ formatTime(timestamp) }}</time></div>
  </div>
</template>
