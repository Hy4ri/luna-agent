<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch } from "vue";
import { loadModels, models, chooseModel, selectedKey } from "@/stores/models";
import ModelSelector from "@/components/ModelSelector.vue";
import type { ModelInfo } from "@/lib/types";


const emit = defineEmits(["open", "close"]);
const pickerRef = ref<HTMLElement | null>(null);
const selectorRef = ref<InstanceType<typeof ModelSelector> | null>(null);

function position() {
  const btn = document.getElementById("model");
  const box = pickerRef.value;
  if (!btn || !box) return;
  const r = btn.getBoundingClientRect();
  const w = Math.min(420, innerWidth - 16);
  const maxH = Math.min(560, r.top - 16);
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
    (pickerRef.value as any)?.hidePopover?.();
    document.getElementById("model")?.focus();
    emit("close");
  }
}

function handleBeforeToggle(e: Event) {
  const open = (e as any).newState === "open";
  document.getElementById("model")?.setAttribute("aria-expanded", String(open));
  if (open) {
    void loadModels();
    try {
      const pins = JSON.parse(localStorage.getItem("luna.pinnedModels") || "[]");
      models.pins = Array.isArray(pins) ? pins.filter((p: unknown) => typeof p === "string") : [];
    } catch { /* keep */ }
    position();
    void nextTick(() => selectorRef.value?.focusSearch());
    emit("open");
  } else {
    emit("close");
  }
}

function closePicker() {
  (pickerRef.value as any)?.hidePopover?.();
}

function onResize() { if ((pickerRef.value as any)?.matches?.(":popover-open")) position(); }

function onDocPointerDown(e: PointerEvent) {
  const box = pickerRef.value;
  if (!(box as any)?.matches?.(":popover-open")) return;
  const t = e.target as Node | null;
  if (!t) return;
  if (box?.contains(t)) return;
  if ((document.getElementById("model") as HTMLElement | null)?.contains(t as Node)) return;
  closePicker();
}

watch(() => models.list.length, () => position());

onMounted(() => {
  pickerRef.value?.addEventListener("beforetoggle", handleBeforeToggle as any);
  window.addEventListener("resize", onResize);
  document.addEventListener("pointerdown", onDocPointerDown);
});
onUnmounted(() => {
  pickerRef.value?.removeEventListener("beforetoggle", handleBeforeToggle as any);
  window.removeEventListener("resize", onResize);
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
  >
    <div class="mp-head">
      <h3>Choose model</h3>
      <p class="muted">{{ models.list.length }} models · pinned stay on top</p>
    </div>

    <ModelSelector
      ref="selectorRef"
      :value="selectedKey"
      placeholder="Search by provider, model, or name…"
      empty-label=""
      autofocus
      @select="handleSelect"
      @close="closePicker"
    />

    <p v-if="!models.list.length" class="muted mp-empty">No connected models — add a provider in Settings → Accounts &amp; connections.</p>
  </div>
</template>

<style scoped>
#model-picker {
  position: fixed;
  margin: 0;
  display: none;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  background: var(--popover);
  color: var(--popover-foreground);
  border: 1px solid var(--border);
  border-radius: 1px;
  box-shadow: 0 16px 48px rgb(0 0 0 / .5), 0 2px 12px rgb(0 0 0 / .35);
  overflow: hidden;
  min-height: 0;
  max-height: min(560px, 70dvh);
  z-index: 30;
}
#model-picker :deep(.model-selector) { min-height: 0; }
#model-picker :deep(input),
#model-picker :deep(.ms-chip),
#model-picker :deep(.ms-pinned),
#model-picker :deep(.ms-pinned-chip),
#model-picker :deep(.ms-row),
#model-picker :deep(.ms-badge),
#model-picker :deep(.ms-pin),
#model-picker .mp-empty { border-radius: 1px; }
#model-picker :deep(.ms-list) { flex: 1; min-height: 120px; }
#model-picker:popover-open { display: flex; }
.mp-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.mp-head h3 { font-size: 14px; font-weight: 650; letter-spacing: -.015em; }
.mp-head .muted { font-size: 12px; color: var(--muted-foreground); }
.mp-empty { font-size: 13px; color: var(--muted-foreground); text-align: center; padding: 12px 8px; border: 1px dashed var(--border); border-radius: var(--radius); background: color-mix(in srgb, var(--card) 60%, transparent); }
</style>
