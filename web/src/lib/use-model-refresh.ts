import { computed, ref, type Ref } from "vue";
import { loadModels, models, refreshCatalog } from "@/stores/models";

type Selector = { revealSelected(): void };

function brief(message: string): string {
  const line = (message.split("\n").find(l => l.trim()) ?? "").trim();
  return line.length > 120 ? line.slice(0, 119) + "…" : line;
}

/**
 * Shared model-list state for the composer picker and the settings combobox.
 * Opening a picker shows the cached list. It loads only when no list exists yet.
 * The catalog refreshes only when the user clicks the refresh button.
 * `canReveal` runs when a load finishes; return true to scroll the selected
 * model into view (only if the user has not interacted since opening).
 */
export function useModelRefresh(selector: Ref<Selector | null>, canReveal: () => boolean = () => true) {
  const loading = ref(false);
  const loadError = ref(false);
  const refreshError = ref("");
  let generation = 0;
  let interacted = false;
  let lastWasCatalog = false;

  async function run(work: () => Promise<boolean>, catalog = false) {
    const request = ++generation;
    lastWasCatalog = catalog;
    loading.value = true;
    loadError.value = false;
    refreshError.value = "";
    try {
      const ok = await work();
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

  /** Reloads the server's current list. Used by Retry after a failed load. */
  function refreshModels() { return run(() => loadModels({ force: true })); }

  /** Asks the server to re-check every provider. Bound to the refresh button. */
  function refreshAll() {
    return run(async () => {
      const r = await refreshCatalog();
      // The picker has room for one short line per provider. Settings shows the full text.
      const failed = Object.entries(r.errors).map(([id, message]) => `${id}: ${brief(message)}`);
      if (r.ok && failed.length) refreshError.value = `Refresh incomplete. ${failed.join("; ").replace(/[.!?:;,]?$/, ".")}`;
      return r.ok;
    }, true);
  }

  /** Repeats the action that failed last: the full refresh or the list reload. */
  function retry() { return lastWasCatalog ? refreshAll() : refreshModels(); }

  /** Call when the popup opens. */
  function begin() {
    interacted = false;
    if (!models.loaded || !models.list.length) void run(() => loadModels());
  }
  /** Call when the popup closes or the owner unmounts. */
  function cancel() { generation++; loading.value = false; }
  function markInteracted() { interacted = true; }

  const errorText = computed(() => {
    if (loadError.value) return models.list.length ? "Could not refresh models. Showing saved models." : "Could not load models.";
    return refreshError.value ? `${refreshError.value} Showing saved models.` : "";
  });

  return { loading, errorText, retry, refreshAll, begin, cancel, markInteracted };
}
