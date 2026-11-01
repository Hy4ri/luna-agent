<script setup lang="ts">
import { ref, computed, defineAsyncComponent, onUnmounted } from "vue";
import { parseWidget } from "@/lib/widgets/schema";
const ChartWidget = defineAsyncComponent(() => import("./ChartWidget.vue"));
const PlotWidget = defineAsyncComponent(() => import("./PlotWidget.vue"));
import { copyToClipboard } from "@/lib/message";
import { MAX_WIDGETS } from "@/lib/segments";

const props = defineProps<{
  json: string;
  closed: boolean;
  excess?: boolean;
}>();

const showRaw = ref(false);
const copyStatus = ref("copy");
let timer: ReturnType<typeof setTimeout> | undefined;

const parseResult = computed(() => {
  if (!props.closed) return { ok: false as const, error: "" };
  if (props.excess) return { ok: false as const, error: `more than ${MAX_WIDGETS} ui/html previews in one message` };
  return parseWidget(props.json);
});

async function handleCopy() {
  clearTimeout(timer);
  const ok = await copyToClipboard(props.json);
  copyStatus.value = ok ? "copied" : "copy failed";
  timer = setTimeout(() => {
    copyStatus.value = "copy";
  }, 2000);
}

onUnmounted(() => {
  clearTimeout(timer);
});
</script>

<template>
  <div class="widget-card">
    <template v-if="!closed">
      <div class="widget-building">building widget…</div>
    </template>
    <template v-else-if="!parseResult.ok">
      <div class="codewrap">
        <div class="code-header">
          <span class="code-lang">json</span>
          <button type="button" class="code-copy-btn" aria-label="Copy code" @click="handleCopy">{{ copyStatus }}</button>
        </div>
        <pre class="code"><code>{{ json }}</code></pre>
      </div>
      <div class="widget-error">widget invalid: {{ parseResult.error }}</div>
    </template>
    <template v-else>
      <div class="widget-header">
        <span class="widget-title">{{ parseResult.widget.title || (parseResult.widget.type === 'chart' ? 'Chart' : 'Plot') }}</span>
        <div class="widget-actions">
          <button type="button" class="widget-action-btn" :class="{ active: showRaw }" title="Toggle raw JSON" @click="showRaw = !showRaw">{ }</button>
          <button type="button" class="code-copy-btn" aria-label="Copy code" @click="handleCopy">{{ copyStatus }}</button>
        </div>
      </div>

      <div v-if="showRaw" class="codewrap">
        <div class="code-header">
          <span class="code-lang">json</span>
        </div>
        <pre class="code"><code>{{ json }}</code></pre>
      </div>

      <div v-else class="widget-body">
        <ChartWidget v-if="parseResult.widget.type === 'chart'" :widget="parseResult.widget" />
        <PlotWidget v-else-if="parseResult.widget.type === 'plot'" :widget="parseResult.widget" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.widget-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  margin: 8px 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  color: var(--card-foreground);
}
.widget-building {
  font-size: 13px;
  color: var(--muted-foreground);
  font-style: italic;
  padding: 8px 0;
}
.widget-error {
  font-size: 13px;
  color: var(--destructive);
  margin-top: 4px;
}
.widget-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.widget-title {
  font-weight: 600;
  font-size: 14px;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.widget-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.widget-action-btn {
  background: var(--secondary);
  border: 1px solid var(--border);
  color: var(--foreground);
  font-family: var(--mono);
  font-size: 12px;
  padding: 2px 6px;
  border-radius: var(--radius);
  cursor: pointer;
}
.widget-action-btn:hover {
  background: var(--accent);
}
.widget-action-btn.active {
  border-color: var(--primary);
  background: var(--acc-soft);
  color: var(--primary);
}
.widget-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
</style>
