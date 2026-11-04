<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch } from "vue";
import { loadModels, models, chooseModel, selectedKey } from "@/stores/models";
import ModelSelector from "@/components/ModelSelector.vue";
import type { ModelInfo } from "@/lib/types";

const searchTarget = ref<HTMLElement>();
const loading = ref(false);
const loadError = ref(false);
const selectError = ref("");

async function refreshModels() {
  loading.value = true;
  loadError.value = false;
  try {
    loadError.value = !(await loadModels({ force: true }));
  } catch {
    loadError.value = true;
  } finally {
    loading.value = false;
    selectorRef.value?.revealSelected();
  }
}

const emit = defineEmits(["open", "close"]);
const pickerRef = ref<HTMLElement | null>(null);
const selectorRef = ref<InstanceType<typeof ModelSelector> | null>(null);

function position() {
  const btn = document.getElementById("model");
  const box = pickerRef.value;
  if (!btn || !box) return;
  const r = btn.getBoundingClientRect();
  const w = Math.min(480, innerWidth - 16);
  const maxH = Math.min(680, r.top - 16);
  Object.assign(box.style, {
    width: w + "px",
    left: Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px",
    bottom: innerHeight - r.top + 8 + "px",
    top: "auto",
    right: "auto",
    maxHeight: maxH + "px",
  } as CSSStyleDeclaration);
}

async function handleSelect(key: string, _model: ModelInfo | null) {
  if (!key) return;
  const [provider, ...rest] = key.split("/");
  const id = rest.join("/");
  const m = models.list.find(x => x.provider === provider && x.id === id) || { provider, id, name: id } as ModelInfo;
  const ok = await chooseModel(m);
  if (ok) {
    selectError.value = "";
    (pickerRef.value as any)?.hidePopover?.();
    document.getElementById("model")?.focus();
    emit("close");
  } else {
    selectError.value = "Could not change model. Try again.";
  }
}

function handleBeforeToggle(e: Event) {
  const open = (e as any).newState === "open";
  document.getElementById("model")?.setAttribute("aria-expanded", String(open));
  if (open) {
    selectError.value = "";
    position();
    void refreshModels();
    void nextTick(() => { selectorRef.value?.focusSearch(); selectorRef.value?.revealSelected(); });
    emit("open");
  } else {
    emit("close");
  }
}

function handleToggle(e: Event) {
  if ((e as ToggleEvent).newState === "open") void nextTick(() => selectorRef.value?.focusSearch());
}

function handleTabKeydown(e: KeyboardEvent) {
  if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
  // Native popover traversal can resume at the invoker after autofocus. Follow the visible controls explicitly.
  const items = [...(pickerRef.value?.querySelectorAll<HTMLElement>('button, input, [tabindex]') ?? [])]
    .filter(el => el.tabIndex >= 0 && !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true' && el.getClientRects().length);
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next = items[index + (e.shiftKey ? -1 : 1)];
  if (next) { e.preventDefault(); next.focus(); }
  else {
    closePicker();
    // Backward exits onto the trigger; forward continues after it in native tab order.
    if (e.shiftKey) e.preventDefault();
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closePicker();
    document.getElementById("model")?.focus();
  }
}

function closePicker(restoreFocus = true) {
  (pickerRef.value as any)?.hidePopover?.();
  if (restoreFocus) document.getElementById("model")?.focus();
}

function onResize() { if ((pickerRef.value as any)?.matches?.(":popover-open")) position(); }

let triggerObserver: ResizeObserver | null = null;
function onViewportResize() { onResize(); }

function onDocPointerDown(e: PointerEvent) {
  const box = pickerRef.value;
  if (!(box as any)?.matches?.(":popover-open")) return;
  const t = e.target as Node | null;
  if (!t) return;
  if (box?.contains(t)) return;
  if ((document.getElementById("model") as HTMLElement | null)?.contains(t as Node)) return;
  closePicker(false);
}

watch(() => models.list.length, () => position());

onMounted(() => {
  pickerRef.value?.addEventListener("beforetoggle", handleBeforeToggle as any);
  window.addEventListener("resize", onResize);
  window.visualViewport?.addEventListener("resize", onViewportResize);
  const btn = document.getElementById("model");
  if (btn && typeof ResizeObserver !== "undefined") {
    triggerObserver = new ResizeObserver(() => onResize());
    triggerObserver.observe(btn);
  }
  document.addEventListener("pointerdown", onDocPointerDown);
});
onUnmounted(() => {
  pickerRef.value?.removeEventListener("beforetoggle", handleBeforeToggle as any);
  window.removeEventListener("resize", onResize);
  window.visualViewport?.removeEventListener("resize", onViewportResize);
  triggerObserver?.disconnect();
  document.removeEventListener("pointerdown", onDocPointerDown);
});
</script>

<template>
  <div
    id="model-picker"
    ref="pickerRef"
    popover
    role="dialog"
    aria-label="Choose model"
    @keydown="handleKeydown"
    @keydown.capture="handleTabKeydown"
    @toggle="handleToggle"
  >
    <div class="mp-head">
      <h3>Choose model</h3>
      <div ref="searchTarget" class="mp-search-slot"></div>
    </div>

    <ModelSelector
      ref="selectorRef"
      compact-picker
      :value="selectedKey"
      :search-target="searchTarget"
      :loading="loading"
      placeholder="Search by provider, model, or name…"
      empty-label=""
      empty-hint="Add a provider in Settings → Accounts & connections."
      @select="handleSelect"
      @close="closePicker"
    />

    <p v-if="loadError && !models.list.length" class="mp-error" role="alert">
      Could not load models.
      <button type="button" class="mp-retry" @click="refreshModels">Retry</button>
    </p>
    <p v-if="selectError" class="mp-error" role="alert">{{ selectError }}</p>
    <p class="mp-hint">↑↓ navigate · Enter select · Esc clear / close</p>
  </div>
</template>

<style scoped>
#model-picker {
  position: fixed;
  margin: 0;
  display: none;
  flex-direction: column;
  gap: 0;
  padding: 8px 10px;
  background: var(--popover);
  color: var(--popover-foreground);
  border: 1px solid var(--border);
  border-radius: 1px;
  box-shadow: 0 16px 48px rgb(0 0 0 / .5), 0 2px 12px rgb(0 0 0 / .35);
  overflow: hidden;
  min-height: 0;
  max-height: min(680px, calc(100dvh - 16px));
  z-index: 30;
}
#model-picker :deep(.model-selector) { min-height: 0; }
#model-picker :deep(input),
#model-picker :deep(.ms-row),
#model-picker :deep(.ms-badge),
#model-picker :deep(.ms-pin),
#model-picker .mp-empty { border-radius: 1px; }
#model-picker :deep(.ms-list) { flex: 1; min-height: 120px; }
#model-picker:popover-open { display: flex; }
.mp-head { display: flex; flex-direction: column; gap: 8px; padding: 0 8px; background: transparent; }
#model-picker :deep(.ms-provider),
#model-picker :deep(.ms-entry) { border: 1px solid color-mix(in srgb, var(--border) 55%, transparent); border-radius: 1px; background: var(--background); }
#model-picker :deep(.ms-section-head) { background: transparent; }
#model-picker :deep(.ms-provider) { background: var(--secondary); }
#model-picker :deep(.ms-provider:hover) { background: var(--accent); }
#model-picker :deep(.ms-entry:not(.ms-entry-pinned)) { border-left: 1px solid var(--border); }
.mp-head h3 { font-size: 14px; font-weight: 650; letter-spacing: -.015em; }
.mp-search-slot { flex: 1; min-width: 0; }
.mp-error { font-size: 13px; color: var(--destructive, #e5484d); text-align: center; padding: 8px; }
.mp-retry { margin-left: 8px; min-height: 32px; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--secondary); color: var(--foreground); cursor: pointer; }
.mp-retry:hover { background: var(--accent); }
.mp-hint { font-size: 11px; color: var(--muted-foreground); text-align: center; padding: 4px 8px 0; }
</style>
