<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";
import { loadModels, models, modelKey, togglePin, chooseModel, selectedKey } from "@/stores/models";

const emit = defineEmits(["close"]);
const pickerRef = ref<HTMLElement | null>(null);
const openProviders = ref(new Set<string>());

function updateOpenProviders() {
  if (!pickerRef.value) return;
  openProviders.value = new Set(
    [...pickerRef.value.querySelectorAll("details[open]")].map((d: any) => d.dataset.provider).filter(Boolean)
  );
}

async function handleSelect(m: any, available: boolean, btnEl: HTMLButtonElement) {
  btnEl.disabled = true;
  try {
    const success = await chooseModel(m);
    if (success) {
      (pickerRef.value as any)?.hidePopover?.();
      document.getElementById("model")?.focus();
      emit("close");
    }
  } finally {
    btnEl.disabled = !available;
  }
}

async function handleSelectPinned(key: string, available: boolean, btnEl: HTMLButtonElement) {
  if (!available) return;
  const [provider, ...idParts] = key.split("/");
  const id = idParts.join("/");
  const m = models.list.find(x => x.provider === provider && x.id === id) || { provider, id, name: id };
  await handleSelect(m, available, btnEl);
}

function handleTogglePin(key: string) {
  updateOpenProviders();
  togglePin(key);
}

function handleBeforeToggle(e: any) {
  const open = e.newState === "open";
  document.getElementById("model")?.setAttribute("aria-expanded", String(open));
  if (open) {
    void loadModels();
    try { const pins = JSON.parse(localStorage.getItem('luna.pinnedModels') || '[]'); models.pins = Array.isArray(pins) ? pins.filter((p: unknown) => typeof p === 'string') : []; } catch { models.pins = []; }
    const modelBtn = document.getElementById("model");
    if (modelBtn && pickerRef.value) {
      const r = modelBtn.getBoundingClientRect();
      const w = Math.min(380, innerWidth - 16);
      const box = pickerRef.value;
      box.style.width = w + "px";
      box.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
      box.style.bottom = (innerHeight - r.top + 8) + "px";
      box.style.top = "auto";
      box.style.right = "auto";
      box.style.maxHeight = Math.max(160, r.top - 16) + "px";
    }
  } else {
    emit("close");
  }
}

onMounted(() => {
  const el = pickerRef.value;
  if (el) {
    el.addEventListener("beforetoggle", handleBeforeToggle);
  }
});

onUnmounted(() => {
  const el = pickerRef.value;
  if (el) {
    el.removeEventListener("beforetoggle", handleBeforeToggle);
  }
});

const groupedModels = computed(() => {
  const map = new Map<string, any[]>();
  for (const m of models.list) {
    if (!map.has(m.provider)) map.set(m.provider, []);
    map.get(m.provider)!.push(m);
  }
  return map;
});

function getModelName(key: string) {
  const found = models.list.find((x: any) => modelKey(x) === key);
  return found?.name || key.split("/")[1];
}

function isAvailable(key: string) {
  return !!models.list.find((x: any) => modelKey(x) === key);
}
</script>

<template>
  <div id="model-picker" ref="pickerRef" popover aria-label="Choose model">
    <section v-if="models.pins.length" aria-label="Pinned models" data-pinned-models>
      <b>Pinned</b>
      <div v-for="key in models.pins" :key="key" class="model-row">
        <button
          type="button"
          class="model-choice"
          :data-model="key"
          :disabled="!isAvailable(key)"
          @click="(e) => handleSelectPinned(key, isAvailable(key), e.currentTarget as HTMLButtonElement)"
        >
          <span>{{ getModelName(key) }}</span>
          <small>{{ key.split('/')[0] }}{{ isAvailable(key) ? '' : ' · Unavailable' }}</small>
        </button>
        <button
          type="button"
          class="model-pin"
          :aria-label="'Unpin ' + key"
          @click="handleTogglePin(key)"
        >
          Unpin
        </button>
      </div>
    </section>

    <template v-for="[provider, provModels] in groupedModels.entries()" :key="provider">
      <details :data-provider="provider" :open="openProviders.has(provider)">
        <summary>{{ provider }} ({{ provModels.length }})</summary>
        <div v-for="m in provModels" :key="modelKey(m)" class="model-row">
          <button
            type="button"
            class="model-choice"
            :data-model="modelKey(m)"
            :aria-current="selectedKey === modelKey(m) ? 'true' : undefined"
            @click="(e) => handleSelect(m, true, e.currentTarget as HTMLButtonElement)"
          >
            <span>{{ m.name || m.id }}</span>
            <small>{{ m.provider }}</small>
          </button>
          <button
            type="button"
            class="model-pin"
            :aria-label="(models.pins.includes(modelKey(m)) ? 'Unpin ' : 'Pin ') + modelKey(m)"
            @click="handleTogglePin(modelKey(m))"
          >
            {{ models.pins.includes(modelKey(m)) ? 'Unpin' : 'Pin' }}
          </button>
        </div>
      </details>
    </template>

    <p class="muted" v-if="!models.list.length">No connected models. Connect a provider to choose a model.</p>
  </div>
</template>
