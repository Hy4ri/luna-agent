<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { Shrink } from "@lucide/vue";
import { post } from "@/lib/api";
import { chat, busy, addErr, contextView } from "@/stores/chat";
import { compactNumber } from "@/lib/numbers";

const trigger = ref<HTMLButtonElement | null>(null);
const popover = ref<HTMLElement | null>(null);
const open = ref(false);

const ctx = computed(() => {
  const view = contextView.value;
  const value = chat.context;
  if (!view) return null;
  if (view.unavailable || !value) {
    return {
      ...view,
      shortPercent: "—",
      percentLabel: "",
      detail: "Unavailable",
    };
  }
  const pct = view.percent;
  const shortPercent = view.known ? `${pct < 10 && pct > 0 ? pct.toFixed(1) : pct.toFixed(0)}%` : "—";
  return {
    ...view,
    shortPercent,
    percentLabel: view.known ? `${pct.toFixed(pct < 10 ? 1 : 0)}%` : "",
    detail: view.known
      ? `≈${compactNumber(value.usedTokens)} / ${compactNumber(value.contextWindow)}`
      : `≈${compactNumber(value.usedTokens)} · capacity unknown`,
  };
});

const usage = computed(() => {
  const rows = Object.values(chat.usage?.models || {}) as any[];
  const toolEntries = Object.entries(chat.usage?.tools || {}) as [string, any][];
  if (!rows.length && !toolEntries.length) return null;
  let fresh = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;
  let cost = 0;
  let priced = 0;
  for (const row of rows) {
    fresh += row.input || 0;
    cacheRead += row.cacheRead || 0;
    cacheWrite += row.cacheWrite || 0;
    output += row.output || 0;
    if (Number.isFinite(row.cost?.total)) {
      cost += row.cost.total;
      priced++;
    }
  }
  let toolTokens = 0;
  let toolCost = 0;
  let toolPriced = 0;
  const toolsList: { name: string; tokensLabel: string; costLabel: string }[] = [];
  for (const [name, row] of toolEntries) {
    const t = row?.totalTokens || 0;
    const c = Number.isFinite(row?.cost?.total) ? row.cost.total : 0;
    if (!t && !c) continue;
    toolTokens += t;
    if (Number.isFinite(row?.cost?.total)) {
      toolCost += c;
      toolPriced++;
    }
    toolsList.push({
      name,
      tokensLabel: compactNumber(t),
      costLabel: Number.isFinite(row?.cost?.total) ? `$${c.toFixed(4)}` : "—",
    });
  }
  const input = fresh + cacheRead + cacheWrite;
  const combinedCost = cost + toolCost;
  const anyPriced = priced + toolPriced > 0;
  return {
    hasModels: rows.length > 0,
    fresh,
    cacheRead,
    cacheWrite,
    input,
    inputLabel: compactNumber(input),
    inputTitle: `${input.toLocaleString()} input tokens`,
    freshLabel: compactNumber(fresh),
    cacheReadLabel: compactNumber(cacheRead),
    cacheWriteLabel: compactNumber(cacheWrite),
    outputLabel: compactNumber(output),
    outputTitle: `${output.toLocaleString()} output tokens`,
    shortCost: anyPriced ? `$${combinedCost < 10 ? combinedCost.toFixed(2) : combinedCost.toFixed(0)}` : "",
    exactCost: priced ? `$${cost.toFixed(4)}` : "—",
    costTitle: priced ? `$${cost.toFixed(4)} · estimated model cost, not an invoice` : "No pricing for this model",
    toolTokens,
    toolTokensLabel: compactNumber(toolTokens),
    toolCostLabel: toolPriced ? `$${toolCost.toFixed(4)}` : "—",
    toolsList,
  };
});

const visible = computed(() => !!(ctx.value || usage.value));
const compacting = ref(false);

async function compactSession() {
  if (!chat.session || busy.value || compacting.value) return;
  compacting.value = true;
  popover.value?.hidePopover();
  try {
    await post(`/v1/sessions/${chat.session}/compact`);
  } catch (error) {
    addErr((error as Error).message);
  } finally {
    compacting.value = false;
  }
}

function position() {
  if (!trigger.value || !popover.value) return;
  const rect = trigger.value.getBoundingClientRect();
  const width = Math.min(380, innerWidth - 16);
  Object.assign(popover.value.style, {
    width: `${width}px`,
    left: `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`,
    bottom: `${innerHeight - rect.top + 10}px`,
    top: "auto",
    right: "auto",
  });
}

function beforeToggle(event: Event) {
  if ((event as ToggleEvent).newState === "open") position();
}

function toggle(event: Event) {
  open.value = (event as ToggleEvent).newState === "open";
}

watch(() => chat.session, () => popover.value?.hidePopover());

onMounted(() => window.addEventListener("resize", position));
onUnmounted(() => window.removeEventListener("resize", position));
</script>

<template>
  <button
    v-if="visible"
    id="composer-usage-trigger"
    ref="trigger"
    type="button"
    popovertarget="composer-usage-popover"
    :data-level="ctx?.level ?? 'unknown'"
    :aria-expanded="open"
    aria-controls="composer-usage-popover"
    aria-haspopup="dialog"
    aria-label="Session context and usage details"
    title="Context & usage details"
  >
    <span v-if="ctx" class="usage-dot" aria-hidden="true"></span>
    <span v-if="ctx" class="usage-pct">{{ ctx.shortPercent }}</span>
    <span v-if="ctx && usage?.shortCost" class="usage-sep" aria-hidden="true">·</span>
    <span v-if="usage?.shortCost" class="usage-cost-val">{{ usage.shortCost }}</span>
  </button>

  <div
    v-if="visible"
    id="composer-usage-popover"
    ref="popover"
    popover="auto"
    role="dialog"
    aria-label="Session context and usage"
    tabindex="-1"
    @beforetoggle="beforeToggle"
    @toggle="toggle"
  >
    <div v-if="ctx" class="usage-pop-ctx" :data-level="ctx.level" :title="ctx.title">
      <div class="usage-pop-head">
        <span class="usage-pop-kicker">Context Window</span>
        <span class="usage-pop-nums">
          {{ ctx.detail }}<template v-if="ctx.percentLabel"> · <b class="usage-pop-pct">{{ ctx.percentLabel }}</b></template>
        </span>
      </div>
      <div
        v-if="ctx.known"
        class="usage-pop-meter"
        role="progressbar"
        aria-label="Estimated context usage"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="ctx.percent"
        :aria-valuetext="ctx.valueText"
      >
        <div class="usage-pop-meter-fill" :style="{ width: `${ctx.percent}%` }"></div>
      </div>
    </div>

    <div v-if="usage && usage.hasModels" class="usage-pop-input">
      <div class="usage-pop-head">
        <span class="usage-pop-sublabel">Input</span>
        <span class="usage-pop-total" :title="usage.inputTitle">{{ usage.inputLabel }}</span>
      </div>
      <div v-if="usage.input > 0" class="usage-split-bar" aria-hidden="true">
        <div v-if="usage.fresh > 0" class="split-seg split-new" :style="{ flex: usage.fresh }"></div>
        <div v-if="usage.cacheRead > 0" class="split-seg split-cache" :style="{ flex: usage.cacheRead }"></div>
        <div v-if="usage.cacheWrite > 0" class="split-seg split-write" :style="{ flex: usage.cacheWrite }"></div>
      </div>
      <div class="usage-legend">
        <span v-if="usage.fresh > 0 || usage.input === 0"><i class="ldot ldot-new" aria-hidden="true"></i>{{ usage.freshLabel }} new</span>
        <span v-if="usage.cacheRead > 0"><i class="ldot ldot-cache" aria-hidden="true"></i>{{ usage.cacheReadLabel }} cache</span>
        <span v-if="usage.cacheWrite > 0"><i class="ldot ldot-write" aria-hidden="true"></i>{{ usage.cacheWriteLabel }} write</span>
      </div>
    </div>

    <div v-if="usage && usage.hasModels" class="usage-pop-foot">
      <span :title="usage.outputTitle">Out <b>{{ usage.outputLabel }}</b></span>
      <span :title="usage.costTitle">Est. <b>{{ usage.exactCost }}</b></span>
    </div>

    <div v-if="usage && usage.toolsList.length" class="usage-pop-tools" title="Auxiliary and sub-call usage recorded separately from the main model ledger">
      <div class="usage-pop-head">
        <span class="usage-pop-sublabel">Tools (separate)</span>
        <span class="usage-pop-total">{{ usage.toolTokensLabel }} · {{ usage.toolCostLabel }}</span>
      </div>
      <div v-for="t in usage.toolsList" :key="t.name" class="usage-tool-row">
        <span>{{ t.name }}</span>
        <span>{{ t.tokensLabel }} · {{ t.costLabel }}</span>
      </div>
    </div>

    <div v-if="chat.session" class="usage-pop-actions">
      <button
        id="composer-usage-compact"
        type="button"
        class="usage-compact-btn"
        :disabled="busy || compacting"
        :title="busy ? 'Cannot compact while busy' : 'Compact context'"
        @click="compactSession"
      >
        <Shrink :size="13" aria-hidden="true" />
        <span>Compact</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
#composer-usage-trigger {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

#composer-usage-trigger:hover,
#composer-usage-trigger[aria-expanded="true"] {
  background: var(--secondary);
  border-color: var(--border);
  color: var(--foreground);
}

#composer-usage-trigger:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}

.usage-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted-foreground);
  flex: none;
}

#composer-usage-trigger[data-level="green"] .usage-dot {
  background: var(--success);
}

#composer-usage-trigger[data-level="amber"] .usage-dot {
  background: var(--warning);
}

#composer-usage-trigger[data-level="red"] .usage-dot {
  background: var(--destructive);
}

.usage-pct {
  color: var(--foreground);
  font-weight: 500;
}

#composer-usage-trigger[data-level="amber"] .usage-pct {
  color: var(--warning);
}

#composer-usage-trigger[data-level="red"] .usage-pct {
  color: var(--destructive);
}

.usage-sep {
  color: var(--border);
}

.usage-cost-val {
  color: var(--muted-foreground);
}

#composer-usage-popover {
  position: fixed;
  margin: 0;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--popover);
  color: var(--foreground);
  box-shadow: var(--shadow);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

#composer-usage-popover:popover-open {
  display: grid;
  gap: 12px;
}

#composer-usage-popover:focus-visible {
  outline: none;
}

.usage-pop-ctx {
  display: grid;
  gap: 7px;
}

.usage-pop-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.usage-pop-kicker {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted-foreground);
}

.usage-pop-nums {
  color: var(--muted-foreground);
}

.usage-pop-pct {
  font-weight: 600;
  color: var(--success);
}

.usage-pop-ctx[data-level="amber"] .usage-pop-pct {
  color: var(--warning);
}

.usage-pop-ctx[data-level="red"] .usage-pop-pct {
  color: var(--destructive);
}

.usage-pop-meter {
  width: 100%;
  height: 4px;
  background: var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.usage-pop-meter-fill {
  height: 100%;
  width: 0;
  background: var(--success);
  transition: width 0.2s ease;
}

.usage-pop-ctx[data-level="amber"] .usage-pop-meter-fill {
  background: var(--warning);
}

.usage-pop-ctx[data-level="red"] .usage-pop-meter-fill {
  background: var(--destructive);
}

.usage-pop-input {
  display: grid;
  gap: 7px;
  padding-top: 2px;
}

.usage-pop-sublabel {
  color: var(--muted-foreground);
}

.usage-pop-total {
  color: var(--foreground);
  font-weight: 500;
}

.usage-split-bar {
  display: flex;
  height: 5px;
  gap: 1px;
  background: var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.split-seg {
  min-width: 2px;
  height: 100%;
}

.split-new {
  background: var(--foreground);
}

.split-cache {
  background: var(--success);
}

.split-write {
  background: var(--warning);
}

.usage-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 11px;
  color: var(--muted-foreground);
}

.ldot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: var(--radius);
  margin-right: 4px;
  vertical-align: middle;
}

.ldot-new {
  background: var(--foreground);
}

.ldot-cache {
  background: var(--success);
}

.ldot-write {
  background: var(--warning);
}

.usage-pop-foot {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  color: var(--muted-foreground);
}

.usage-pop-foot b {
  color: var(--foreground);
  font-weight: 500;
  margin-left: 4px;
}

.usage-pop-tools {
  display: grid;
  gap: 5px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

.usage-tool-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 11px;
  color: var(--muted-foreground);
}

.usage-pop-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

.usage-compact-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--secondary);
  color: var(--foreground);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.usage-compact-btn:hover:not(:disabled) {
  background: var(--accent, var(--secondary));
  border-color: var(--muted-foreground);
}

.usage-compact-btn:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}

.usage-compact-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

@media (max-width: 760px), (pointer: coarse) {
  #composer-usage-trigger {
    min-height: 44px;
    height: 44px;
    padding: 0 10px;
    gap: 5px;
  }

  .usage-compact-btn {
    min-height: 44px;
    padding: 0 14px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .usage-pop-meter-fill {
    transition: none;
  }
}
</style>
