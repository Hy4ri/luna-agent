<script setup lang="ts">
import { computed, ref } from 'vue';
import { Check, CircleAlert, LoaderCircle, ChevronRight } from '@lucide/vue';
import { chat, openSession, toolArgsText } from '@/stores/chat';
import { formatTime, formatDateIso } from '@/lib/message';
import { toolSummary, parseEditDiff, argsEditDiff, diffCounts, bashResult, ansiSpans } from '@/lib/tool-view';
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
const summary = computed(() => toolSummary(props.name, props.args));

// edit: the tool's own diff (real line numbers) when it finished; otherwise the requested old/new text.
const isEdit = computed(() => props.name === 'edit' && (typeof result.value?.details?.diff === 'string' || argsEditDiff(props.args).length > 0));
const editApplied = computed(() => state.value === 'complete' && typeof result.value?.details?.diff === 'string');
const diffRows = computed(() => !isEdit.value ? [] : editApplied.value ? parseEditDiff(result.value.details.diff) : argsEditDiff(props.args));
const counts = computed(() => diffCounts(diffRows.value));

// bash: terminal output; a nonzero exit is read from the runtime's diagnostics block.
const isBash = computed(() => props.name === 'bash');
const bash = computed(() => {
  if (!isBash.value) return { output: '', diagnostics: '' } as ReturnType<typeof bashResult>;
  if (result.value) return bashResult(output.value);
  const prefix = toolArgsText(props.args);
  return { output: output.value.startsWith(prefix) ? output.value.slice(prefix.length) : output.value, diagnostics: '' };
});
const bashSpans = computed(() => ansiSpans(bash.value.output.replace(/\n+$/, '')));
const bashExit = computed(() => bash.value.exit !== undefined && bash.value.exit !== 0 ? bash.value.exit : undefined);
const special = computed(() => isEdit.value || isBash.value);
</script>
<template>
  <div class="tool" :data-call="id" :data-state="state" :data-tool="special ? name : undefined">
    <details :open="expanded" @toggle="expanded = ($event.target as HTMLDetailsElement).open">
      <summary>
        <CircleAlert v-if="state === 'failed'" :size="14" class="tool-status-icon" aria-hidden="true" />
        <Check v-else-if="state === 'complete'" :size="14" aria-hidden="true" />
        <LoaderCircle v-else :size="14" aria-hidden="true" />
        <span class="tool-name">{{ name }}</span>
        <span v-if="summary" class="tool-summary" :title="summary">{{ isBash ? '$ ' + summary : summary }}</span>
        <span v-if="editApplied && (counts.add || counts.del)" class="tool-counts"><span class="diff-add-count">+{{ counts.add }}</span> <span class="diff-del-count">−{{ counts.del }}</span></span>
        <span v-if="bashExit !== undefined" class="tool-exit">exit {{ bashExit }}</span>
        <span class="tool-state">{{ state === 'failed' ? 'Failed' : state === 'complete' ? 'Complete' : state === 'running' ? 'Running' : 'No result' }}</span>
        <a v-if="child" href="#" @click.prevent.stop="openSession(child)">Child {{ child }}</a>
        <ChevronRight :size="13" class="disclosure-chevron" aria-hidden="true" />
      </summary>
      <div v-if="isEdit" class="tool-section">
        <span class="tool-section-label">{{ editApplied ? 'Diff' : 'Requested change (not applied, no line numbers)' }}</span>
        <div class="diff" role="table" :aria-label="'Changes to ' + summary">
          <div v-for="(row, i) in diffRows" :key="i" class="diff-row" :data-kind="row.kind" role="row">
            <span class="diff-line" role="cell">{{ row.line ?? '' }}</span><span class="diff-sign" role="cell">{{ row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : '' }}</span><span class="diff-text" role="cell">{{ row.text }}</span>
          </div>
        </div>
      </div>
      <div v-else-if="isBash && state !== 'failed' && bash.output" class="tool-section"><pre class="terminal"><span v-for="(s, i) in bashSpans" :key="i" :class="s.cls || undefined">{{ s.text }}</span></pre></div>
      <template v-if="special">
        <details v-if="argumentsText" class="tool-raw"><summary>Raw arguments</summary><pre>{{ argumentsText }}</pre></details>
      </template>
      <template v-else>
        <div v-if="argumentsText" class="tool-section"><span class="tool-section-label">Arguments</span><pre>{{ argumentsText }}</pre></div>
        <div v-if="state !== 'failed' && output" class="tool-section"><span class="tool-section-label">Output</span><pre>{{ output }}</pre></div>
      </template>
      <img v-for="(image, i) in images" :key="i" class="tool-image" :src="`data:${image.mimeType};base64,${image.data}`" :alt="name + ' result'" />
    </details>
    <div v-if="state === 'failed' && isBash && bash.exit !== undefined" class="tool-error"><span class="tool-section-label">Exited with code {{ bash.exit }}</span><pre class="terminal"><span v-for="(s, i) in bashSpans" :key="i" :class="s.cls || undefined">{{ s.text }}</span><template v-if="!bash.output.trim()">No output.</template></pre></div>
    <div v-else-if="state === 'failed'" class="tool-error"><span class="tool-section-label">Error</span><pre>{{ output || 'The tool failed without error details.' }}</pre></div>
    <div v-if="formatTime(timestamp)" class="tool-footer"><time :datetime="formatDateIso(timestamp)" :title="fullDate">{{ formatTime(timestamp) }}</time></div>
  </div>
</template>
