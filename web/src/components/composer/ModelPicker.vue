<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch } from "vue";
import { models, chooseModel, selectedKey } from "@/stores/models";
import { useModelRefresh } from "@/lib/use-model-refresh";
import ModelSelector from "@/components/ModelSelector.vue";
import type { ModelInfo } from "@/lib/types";

const searchTarget = ref<HTMLElement>();
const selectError = ref("");
const selecting = ref(false);
let openGeneration = 0;

const emit = defineEmits(["open", "close"]);
const pickerRef = ref<HTMLElement | null>(null);
const selectorRef = ref<InstanceType<typeof ModelSelector> | null>(null);
const { loading, errorText, refreshModels, begin, cancel, markInteracted } = useModelRefresh(selectorRef, () => !!pickerRef.value?.matches(":popover-open"));

function position() {
  const btn = document.getElementById("model");
  const box = pickerRef.value;
  if (!btn || !box) return;
  const r = btn.getBoundingClientRect();
  const viewport = window.visualViewport;
  const visible = viewport?.scale === 1 ? viewport : null;
  const left = visible?.offsetLeft ?? 0;
  const top = visible?.offsetTop ?? 0;
  const width = visible?.width ?? innerWidth;
  const height = visible?.height ?? innerHeight;
  const w = Math.min(480, width - 16);
  // The keyboard can cover the trigger without resizing the layout viewport.
  const anchorTop = Math.max(top + 8, Math.min(r.top, top + height - 8));
  const anchorBottom = Math.max(top + 8, Math.min(r.bottom, top + height - 8));
  const above = Math.max(0, anchorTop - top - 16);
  const below = Math.max(0, top + height - anchorBottom - 16);
  // Prefer the space above the composer. Fall back below only if it has more room.
  const useAbove = above >= Math.min(320, height / 2) || above >= below;
  Object.assign(box.style, {
    width: w + "px",
    left: Math.max(left + 8, Math.min(r.left, left + width - w - 8)) + "px",
    bottom: useAbove ? innerHeight - anchorTop + 8 + "px" : "auto",
    top: useAbove ? "auto" : anchorBottom + 8 + "px",
    right: "auto",
    maxHeight: Math.min(680, useAbove ? above : below) + "px",
  } as CSSStyleDeclaration);
}

async function handleSelect(key: string, _model: ModelInfo | null) {
  if (!key || selecting.value) return;
  const opening = openGeneration;
  const [provider, ...rest] = key.split("/");
  const id = rest.join("/");
  const m = models.list.find(x => x.provider === provider && x.id === id) || { provider, id, name: id } as ModelInfo;
  selecting.value = true;
  selectError.value = "";
  try {
    const ok = await chooseModel(m);
    if (opening !== openGeneration) return;
    if (ok) closePicker();
    else selectError.value = "Could not change model. Try again.";
  } finally {
    selecting.value = false;
  }
}

function handleBeforeToggle(e: Event) {
  const open = (e as any).newState === "open";
  openGeneration++;
  document.getElementById("model")?.setAttribute("aria-expanded", String(open));
  if (open) {
    selectError.value = "";
    selectorRef.value?.prepareOpen();
    position();
    begin();
    void nextTick(() => selectorRef.value?.focusSearch());
    emit("open");
  } else {
    cancel();
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
  window.visualViewport?.addEventListener("scroll", onViewportResize);
  window.addEventListener("scroll", onResize, true);
  const btn = document.getElementById("model");
  if (btn && typeof ResizeObserver !== "undefined") {
    triggerObserver = new ResizeObserver(() => onResize());
    triggerObserver.observe(btn);
    if (btn.parentElement?.parentElement) triggerObserver.observe(btn.parentElement.parentElement);
  }
  document.addEventListener("pointerdown", onDocPointerDown);
});
onUnmounted(() => {
  pickerRef.value?.removeEventListener("beforetoggle", handleBeforeToggle as any);
  window.removeEventListener("resize", onResize);
  window.visualViewport?.removeEventListener("resize", onViewportResize);
  window.visualViewport?.removeEventListener("scroll", onViewportResize);
  window.removeEventListener("scroll", onResize, true);
  cancel();
  openGeneration++;
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
    @pointerdown.capture="markInteracted"
    @wheel.passive="markInteracted"
    @keydown.capture="markInteracted(); handleTabKeydown($event)"
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
      :selecting="selecting"
      :error="errorText"
      placeholder="Search by provider, model, or name…"
      empty-label=""
      empty-hint="Add a provider in Settings → Accounts & connections."
      @retry="refreshModels"
      @select="handleSelect"
      @close="closePicker"
    />

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
#model-picker :deep(.model-selector) { flex: 1 1 auto; min-height: 0; margin-top: 8px; }
#model-picker :deep(input),
#model-picker :deep(.ms-row),
#model-picker :deep(.ms-badge),
#model-picker :deep(.ms-pin) { border-radius: 1px; }
#model-picker:popover-open { display: flex; }
.mp-head { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 0 8px; background: transparent; }
#model-picker :deep(.ms-provider),
#model-picker :deep(.ms-entry) { border: 1px solid color-mix(in srgb, var(--border) 55%, transparent); border-radius: 1px; background: var(--background); }
#model-picker :deep(.ms-section-head) { background: transparent; }
#model-picker :deep(.ms-provider) { background: var(--secondary); }
#model-picker :deep(.ms-provider:hover) { background: var(--accent); }
#model-picker :deep(.ms-entry:not(.ms-entry-pinned)) { border-left: 1px solid var(--border); }
.mp-head h3 { font-size: 14px; font-weight: 650; letter-spacing: -.015em; }
.mp-search-slot { flex: none; min-width: 0; }
.mp-error { flex: none; font-size: 13px; color: var(--destructive); text-align: center; padding: 8px; }
.mp-hint { flex: none; font-size: 11px; color: var(--muted-foreground); text-align: center; padding: 4px 8px 0; }
</style>
