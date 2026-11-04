import { computed, ref, type Ref } from "vue";
import { loadModels, models } from "@/stores/models";

type Selector = { revealSelected(): void };

/**
 * Shared model-list refresh for the composer picker and the settings combobox.
 * `canReveal` runs when a refresh finishes; return true to scroll the selected
 * model into view (only if the user has not interacted since opening).
 */
export function useModelRefresh(selector: Ref<Selector | null>, canReveal: () => boolean = () => true) {
  const loading = ref(false);
  const loadError = ref(false);
  let generation = 0;
  let interacted = false;

  async function refreshModels() {
    const request = ++generation;
    loading.value = true;
    loadError.value = false;
    try {
      const ok = await loadModels({ force: true });
      if (request === generation) loadError.value = !ok;
    } catch {
      if (request === generation) loadError.value = true;
    } finally {
      if (request === generation) {
        loading.value = false;
        if (!interacted && canReveal()) selector.value?.revealSelected();
      }
    }
  }

  /** Call when the popup opens. */
  function begin() { interacted = false; void refreshModels(); }
  /** Call when the popup closes or the owner unmounts. */
  function cancel() { generation++; loading.value = false; }
  function markInteracted() { interacted = true; }

  const errorText = computed(() =>
    loadError.value ? (models.list.length ? "Could not refresh models. Showing saved models." : "Could not load models.") : "");

  return { loading, errorText, refreshModels, begin, cancel, markInteracted };
}
